/**
 * Translate a bundle's prose into Chinese, in parallel, at ingest.
 *
 * Done once when a trace is ingested rather than on demand in the browser: the
 * page is a static export with no server, and a translation that runs per
 * reader is a translation that differs per reader. Once at ingest means one
 * artefact, one pair of texts, reproducible.
 *
 * ## Why the model lives on a different gateway
 *
 * `deepseek-v4-pro` is on the **Beijing** gateway; the writing models are on
 * Singapore. The gateway routes by model family and a cross-gateway call
 * returns 404 rather than an error that says why — which is exactly what
 * probing `ds-v4-pro` against Singapore produced. Both endpoints are therefore
 * named explicitly here rather than shared.
 *
 * ## Concurrency
 *
 * A bundle is hundreds of independent short texts, so this is the ideal shape
 * for parallelism: no ordering, no shared state, and the only limit is the
 * provider's. The default of 100 is what the model tolerates comfortably; the
 * semaphore exists because the failure mode of removing it is not "faster", it
 * is a burst of 429s that then have to be retried serially anyway.
 */

import type { Bilingual, TraceBundle } from "./types.ts";

/** DeepSeek is on the Beijing gateway. Calling it on Singapore returns 404. */
export const BEIJING_GATEWAY = "https://ai-prod.wenxiaobai.com/v1/chat/completions";
export const TRANSLATION_MODEL = "deepseek-v4-pro";

/**
 * How the translator is told to behave.
 *
 * The instructions that matter are the negative ones. This text sits beside the
 * English on a technical page, so a translation that smooths over a term, or
 * helpfully explains one, stops being a translation of the artefact. Identifiers
 * and file paths especially: `char-jonah-vale` translated is a broken reference.
 */
const SYSTEM_PROMPT = [
  "You translate English technical and literary text into Simplified Chinese for a",
  "side-by-side bilingual view. Output only the translation — no preamble, no notes, no",
  "quotation marks around the whole thing.",
  "",
  "Rules:",
  "- Keep every identifier, file path, entity id, model name, tool name and number exactly",
  "  as written: char-jonah-vale, novel/chapters/ch-01/scenes/s-001.md, gpt-5-mini,",
  "  call_context_builder, 2,065,552. Do not translate or reformat them.",
  "- Keep Markdown structure: headings, list markers, code fences, bold, tables.",
  "- Translate prose faithfully and idiomatically. Do not summarise, expand, explain or",
  "  improve. If the English is awkward or wrong, the Chinese should be too.",
  "- Established terms keep their English where a Chinese rendering would be a guess:",
  "  packet, prompt, token, commit, verifier, orchestrator, backfill.",
  "- For narrative prose, translate as literature: keep voice, tense and rhythm.",
].join("\n");

/**
 * Proper nouns, translated once and then pinned for every other unit.
 *
 * The reason this phase exists is a defect in the obvious design. Units are
 * translated independently and in parallel, which is what makes 70 sections
 * take 72 seconds — and it also means no unit can know what another chose. In
 * the first bilingual bundle, `Hale` came back as 哈尔 in the manuscript and
 * 黑尔 in a verifier finding about the same character. For a continuity system
 * that is a particularly bad thing to be sloppy about.
 *
 * One call fixes the whole cast, and the result goes into every subsequent
 * prompt as a table the translator is told to follow rather than re-decide.
 */
async function buildGlossary(
  names: readonly string[],
  options: TranslateOptions,
): Promise<string> {
  if (names.length === 0) return "";
  const asked = [
    "Give the standard Simplified Chinese rendering for each proper noun below.",
    "Output one per line as `English<TAB>Chinese`, nothing else. No numbering, no notes.",
    "Use the conventional transliteration a published translation would use.",
    "",
    ...names,
  ].join("\n");
  const answer = await translateOne(asked, options);
  if (!answer) return "";
  const rows = answer
    .split("\n")
    .map((l) => l.split(/\t|\s{2,}|：|:/).map((c) => c.trim()))
    .filter((c) => c.length >= 2 && c[0] && c[1])
    .map(([a, b]) => `${a} → ${b}`);
  return rows.join("\n");
}

/** Words that describe a role rather than name a person. */
const ROLE_WORDS =
  /^(inspector|constable|sir|mr|mrs|miss|doctor|lord|lady|sergeant|captain|the|old|young|house|study|hall|garden|shed)$/i;

/**
 * Proper nouns worth pinning, derived from the plan's entity ids.
 *
 * The ids are the authoritative name list — `char-inspector-hale` is where
 * "Hale" is actually defined — and the first version of this function looked at
 * the *sketches* instead. It therefore missed Hale entirely, because his sketch
 * reads "Metropolitan police inspector in charge of the case" and never names
 * him; the glossary came back without him and he was rendered 黑尔 sixty-three
 * times and 海尔 ten. It also scraped every capitalised word it found, which
 * produced entries like `Wry → 扭曲` and `Stopped → 停滞` — ordinary adjectives
 * that began a sentence, pinned as though they were names.
 *
 * Working from ids fixes both: the list is exactly the cast, and nothing else
 * can get in.
 */
export function properNouns(bundle: TraceBundle): string[] {
  const found = new Set<string>();
  for (const entity of bundle.plan.entities) {
    if (!entity.id.startsWith("char-")) continue;
    const parts = entity.id.replace(/^char-/, "").split("-").filter(Boolean);
    if (parts.length === 0) continue;
    const titled = parts.map((p) => p[0]!.toUpperCase() + p.slice(1));
    // The full form, as a scene card would write it.
    found.add(titled.join(" "));
    // And each name-like token on its own, because prose says "Hale" far more
    // often than "Inspector Hale", and it is the bare form that drifted.
    for (const token of titled) {
      if (token.length >= 3 && !ROLE_WORDS.test(token)) found.add(token);
    }
  }
  return [...found].slice(0, 60);
}

export interface TranslateOptions {
  readonly apiKey: string;
  /** Requests in flight. The model tolerates 100 comfortably. */
  readonly concurrency?: number;
  readonly model?: string;
  readonly endpoint?: string;
  /** Called after each unit, for a progress line on a long ingest. */
  readonly onProgress?: (done: number, total: number) => void;
  /** Attempts per unit before giving up on it. */
  readonly maxAttempts?: number;
  /** The pinned name table, once it has been resolved. */
  readonly onGlossary?: (glossary: string) => void;
}

/** One translatable unit: where it lives in the bundle, and its English text. */
interface Unit {
  readonly text: string;
  apply(zh: string): void;
}

async function translateOne(
  text: string,
  options: TranslateOptions,
  attempt = 1,
  glossary = "",
): Promise<string | null> {
  const maxAttempts = options.maxAttempts ?? 4;
  try {
    const response = await fetch(options.endpoint ?? BEIJING_GATEWAY, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model ?? TRANSLATION_MODEL,
        messages: [
          {
            role: "system",
            content: glossary
              ? `${SYSTEM_PROMPT}\n\n## Names — use exactly these renderings\n\n${glossary}`
              : SYSTEM_PROMPT,
          },
          { role: "user", content: text },
        ],
        // Generous, because a long scene of prose is one unit and truncating it
        // mid-sentence would be worse than not translating it at all.
        max_tokens: 16_000,
      }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    return content || null;
  } catch (error) {
    if (attempt >= maxAttempts) {
      // A unit that could not be translated stays English. Leaving it visibly
      // untranslated is honest; substituting anything else is not.
      console.error(
        `translation failed after ${attempt} attempts: ${
          error instanceof Error ? error.message.slice(0, 160) : String(error)
        }`,
      );
      return null;
    }
    await new Promise((r) => setTimeout(r, 2_000 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5)));
    return translateOne(text, options, attempt + 1, glossary);
  }
}

/**
 * Longest text sent in one request.
 *
 * Measured rather than chosen: on a deep ingest of `lbw081`, blocks in the
 * 3,000–8,000 character band came back with a median 57% CJK ratio and one
 * failure in 47, while blocks above 8,000 characters failed 8 times in 33 — the
 * model stops translating and starts echoing its input, sometimes reordered. The
 * failure is silent, and a block of English sitting under a 中文 label is worse
 * than an untranslated block that says so.
 */
const MAX_CHARS_PER_REQUEST = 2_500;

/**
 * Split on paragraph boundaries, never mid-sentence.
 *
 * A translation joined back together from arbitrary cuts reads as a translation
 * joined back together from arbitrary cuts. Paragraphs are the smallest unit that
 * survives being translated independently.
 */
export function chunkForTranslation(text: string, limit = MAX_CHARS_PER_REQUEST): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  // Keeping the separators means the rejoined text has the original shape.
  for (const paragraph of text.split(/(?<=\n\n)/)) {
    if (current && current.length + paragraph.length > limit) {
      chunks.push(current);
      current = "";
    }
    if (paragraph.length > limit) {
      // A single paragraph over the limit — fall back to lines, which is still a
      // boundary a reader would recognise.
      for (const line of paragraph.split(/(?<=\n)/)) {
        if (current && current.length + line.length > limit) {
          chunks.push(current);
          current = "";
        }
        current += line;
      }
      continue;
    }
    current += paragraph;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Whether a reply is a translation at all, as opposed to the source echoed back.
 *
 * Only applied where the answer is unambiguous: a source with real prose in it
 * (200+ Latin letters) whose "translation" is almost free of Chinese characters
 * did not get translated. Short technical strings — a path, a JSON fragment, an
 * id — legitimately contain almost no Chinese and are left alone, because a check
 * that fires on those would reject correct output.
 */
function looksTranslated(source: string, candidate: string): boolean {
  const latin = (source.match(/[A-Za-z]/g) ?? []).length;
  if (latin < 200) return true;
  const cjk = (candidate.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return cjk / Math.max(1, candidate.length) >= 0.1;
}

/**
 * Translate one field, chunking it if it is long and refusing an untranslated
 * reply.
 *
 * A chunk that cannot be translated keeps its English, so a partial failure
 * degrades to a partially English block rather than losing the whole field.
 */
async function translateText(
  text: string,
  options: TranslateOptions,
  glossary: string,
): Promise<string | null> {
  const chunks = chunkForTranslation(text);
  const out: string[] = [];
  let translatedAny = false;

  for (const chunk of chunks) {
    const zh = await translateOne(chunk, options, 1, glossary);
    if (zh && looksTranslated(chunk, zh)) {
      out.push(zh);
      translatedAny = true;
    } else {
      out.push(chunk);
    }
  }

  return translatedAny ? out.join("") : null;
}

/** Every prose field in the bundle, as a flat list of units to fill in. */
function unitsOf(bundle: TraceBundle): Unit[] {
  const units: Unit[] = [];
  const add = (b: Bilingual) => {
    if (!b.en?.trim()) return;
    units.push({
      text: b.en,
      apply: (zh) => {
        (b as { zh?: string }).zh = zh;
      },
    });
  };

  add(bundle.harnessVersionNote);
  if (bundle.task) add(bundle.task.prompt);
  add(bundle.plan.logline);
  bundle.plan.worldRules.forEach(add);
  bundle.plan.entities.forEach((e) => add(e.sketch));
  for (const scene of bundle.scenes) {
    add(scene.intent);
    // The allowance's reason, which is the same sentence on every scene of a tier
    // — the translator's cache does not know that, so it is a handful of repeated
    // units per run rather than one. Cheap enough to leave, and cutting it would
    // mean the reason renders in English on a page set to Chinese.
    if (scene.allocation) add(scene.allocation.rationale);
    if (scene.failureReason) add(scene.failureReason);
    scene.findings.forEach((f) => add(f.reasoning));
    scene.gaps.forEach((g) => add(g.need));
    scene.artifacts.forEach((a) => add(a.body));
    // Present only on a deep ingest, and then it is the bulk of the work: the
    // prompts and replies of every model call in the scene.
    for (const step of scene.steps ?? []) {
      for (const message of step.messages) add(message.body);
    }
  }
  bundle.memory.forEach((m) => add(m.body));
  add(bundle.manuscript);
  add(bundle.revisionPlan);
  return units;
}

/**
 * Fill in every `zh` field, in place.
 *
 * Mutating the bundle rather than rebuilding it, because the alternative is a
 * deep clone that has to know the shape of every nested field — and the thing
 * that would break silently is a field the clone forgot.
 */
export async function translateBundle(
  bundle: TraceBundle,
  options: TranslateOptions,
): Promise<TraceBundle> {
  const units = unitsOf(bundle);
  const limit = options.concurrency ?? 100;

  // One serial call before the parallel pass, so every unit renders the cast
  // the same way. Without it the same character was 哈尔 in the manuscript and
  // 黑尔 in a finding about him.
  const glossary = await buildGlossary(properNouns(bundle), options);
  options.onGlossary?.(glossary);

  let done = 0;
  let index = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const mine = index++;
      if (mine >= units.length) return;
      const unit = units[mine]!;
      const zh = await translateText(unit.text, options, glossary);
      if (zh) unit.apply(zh);
      options.onProgress?.(++done, units.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, units.length) }, worker));

  return {
    ...bundle,
    translation: {
      model: options.model ?? TRANSLATION_MODEL,
      at: new Date().toISOString(),
      sections: units.length,
      glossary,
    },
  };
}

/** Count the units without translating, for a dry run. */
export function countUnits(bundle: TraceBundle): number {
  return unitsOf(bundle).length;
}
