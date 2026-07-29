/**
 * One book, one spelling. The same defect as the narrative person, one layer down.
 *
 * The writer's session resets per scene, so nothing carries a convention from one
 * scene to the next unless something states it. Before 0.8.0 that produced
 * narrative-person drift; the person is now declared and checked, and the
 * measurement of what replaced it is unambiguous. Across ten manuscripts on the
 * fixed harness `style_shifts` is the largest single consistency subtype — 30 of
 * 87 kept instances, 1.83 per 10,000 words — and on `task-literary-yesteryear`
 * five of its six are this:
 *
 *     memorised / memorized      labour / labor        realised / realized
 *     practised / practiced      flavour / flavor
 *
 * plus one quotation-mark convention, `‘…’` against `"…"`. Eight scenes each
 * chose, which is exactly what "each scene decides for itself" produces.
 *
 * Deliberately not a plan field. `submit_plan` already refuses often enough to
 * cost planning round-trips, and a convention is not a judgement worth a model
 * call: the first committed scene establishes it, later scenes are checked
 * against it, and the decision is written where everything is told to look. A
 * mechanism rather than an instruction, which is the lesson this project has
 * measured twice.
 */

/** Spelling systems we can tell apart from evidence, not from a locale name. */
export type Orthography = "british" | "american";

/**
 * The script a scene is written in.
 *
 * A coarser and more serious version of the same defect, and it happens: on
 * `lbw119` — a Chinese request to write in the manner of 《明朝那些事儿》 — **seven
 * of seventeen committed scenes came out in English**, and the frozen judge said
 * so in as many words, "switches inexplicably between Chinese and English", scoring
 * Accuracy 2. Five of twenty-one manuscripts drift this way.
 *
 * Same cause as the spelling and the narrative person before it: the writer's
 * session resets per scene, the plan has no field for the language, and each
 * scene decides for itself. So it gets the same treatment rather than a new one —
 * observed from the first committed scene, written into `voice.md`, checked
 * deterministically.
 */
export type Script = "han" | "latin";

export interface OrthographyConvention {
  readonly spelling: Orthography;
  /** Which quotation mark opens direct speech, as observed. */
  readonly quotes: "double" | "single";
  /**
   * The script the book is written in.
   *
   * Optional so that every existing caller and every stored convention stays
   * valid; absent means "not established", which is what a scene with too little
   * text to judge produces.
   */
  readonly script?: Script;
}

const HAN = /[\u4e00-\u9fff]/g;
/** Latin words of two letters or more, so stray initialisms do not count as prose. */
const LATIN_WORD = /\b[a-zA-Z]{2,}\b/g;

/**
 * Which script carries this text, or null when there is too little to tell.
 *
 * Counted rather than detected by locale, and compared by weight rather than by
 * presence: a Chinese novel may legitimately carry an English name or a quoted
 * term, and an English one may carry a Chinese title. What is not legitimate is a
 * scene of a Chinese book written in English.
 *
 * The book's script is read from **the request**, not from the first committed
 * scene, and that distinction was found by replay rather than by reasoning. On
 * `lbw068` — a Chinese prompt asking for five diary entries — the first scene came
 * out in English and the rest in Chinese; a convention taken from scene one would
 * have locked the book to English and then demanded a rewrite of the three correct
 * scenes. Deriving it from the request also lets the very first scene be checked,
 * which is the one that would otherwise establish whatever it happened to choose.
 */
export function scriptOf(text: string, minTokens = SCENE_MIN_TOKENS): Script | null {
  const han = (text.match(HAN) ?? []).length;
  const latin = (text.match(LATIN_WORD) ?? []).length;
  if (han + latin < minTokens) return null;
  return han > latin ? "han" : "latin";
}

/**
 * How much text is enough to call a scene's script.
 *
 * Fifty tokens because the cost of guessing wrong on a scene is a rewrite demanded
 * of correct prose, and a very short scene carries little.
 */
const SCENE_MIN_TOKENS = 50;

/**
 * The same call for a request, which needs far less.
 *
 * A prompt is categorical evidence in a way a scene fragment is not: "请写一份有五个
 * 人搞笑的青春校园剧本" is unambiguously a Chinese request at thirty characters, and
 * there is no longer version of it coming. The scene threshold applied here simply
 * returned null for most real prompts, which silently disabled the check.
 */
export function requestScriptOf(request: string): Script | null {
  return scriptOf(request, 12);
}

/**
 * Word pairs that differ only by convention, so a hit is evidence rather than a
 * guess. Each entry is `[british, american]` and both spellings are real words
 * of the same meaning — no `practice`/`practise` noun-verb pair, because English
 * uses those differently on both sides of the Atlantic and a checker cannot tell
 * which was meant.
 */
const PAIRS: readonly (readonly [string, string])[] = [
  ["realise", "realize"],
  ["realised", "realized"],
  ["realising", "realizing"],
  ["memorise", "memorize"],
  ["memorised", "memorized"],
  ["recognise", "recognize"],
  ["recognised", "recognized"],
  ["apologise", "apologize"],
  ["apologised", "apologized"],
  ["organise", "organize"],
  ["organised", "organized"],
  ["labour", "labor"],
  ["labours", "labors"],
  ["laboured", "labored"],
  ["flavour", "flavor"],
  ["flavours", "flavors"],
  ["colour", "color"],
  ["colours", "colors"],
  ["coloured", "colored"],
  ["honour", "honor"],
  ["honoured", "honored"],
  ["neighbour", "neighbor"],
  ["neighbours", "neighbors"],
  ["harbour", "harbor"],
  ["rumour", "rumor"],
  ["odour", "odor"],
  ["grey", "gray"],
  ["travelled", "traveled"],
  ["travelling", "traveling"],
  ["cancelled", "canceled"],
  ["marvelled", "marveled"],
  ["theatre", "theater"],
  ["centre", "center"],
  ["centres", "centers"],
  ["metre", "meter"],
  ["metres", "meters"],
  ["defence", "defense"],
  ["offence", "offense"],
  ["practised", "practiced"],
  ["practising", "practicing"],
];

function count(text: string, word: string): number {
  const re = new RegExp(`\\b${word}\\b`, "gi");
  return (text.match(re) ?? []).length;
}

/**
 * The convention a finished scene is written in.
 *
 * Returns null when the text carries no evidence either way, which is common in
 * a short scene and must not be turned into a decision — a guessed convention
 * would make every later scene wrong half the time.
 */
export function conventionOf(text: string): OrthographyConvention | null {
  let british = 0;
  let american = 0;
  for (const [gb, us] of PAIRS) {
    if (gb === us) continue;
    british += count(text, gb);
    american += count(text, us);
  }
  if (british === 0 && american === 0) return null;
  // Quotation style from the opening mark of direct speech, counted rather than
  // inferred from the spelling system: the two are independent choices.
  const single = (text.match(/[‘']\s*[A-Z]/g) ?? []).length;
  const double = (text.match(/[“"]\s*[A-Z]/g) ?? []).length;
  return {
    spelling: british > american ? "british" : "american",
    quotes: single > double ? "single" : "double",
  };
}

/**
 * The scene is written in the other script, or null when it agrees.
 *
 * Returned as one finding rather than per sentence: a scene in the wrong language
 * is one decision, and the repair is to rewrite the scene, not to fix a line.
 */
export function findScriptDrift(
  draft: string,
  convention: OrthographyConvention,
): OrthographyDrift | null {
  if (!convention.script) return null;
  const actual = scriptOf(draft);
  if (!actual || actual === convention.script) return null;
  const name = (s: Script) => (s === "han" ? "Chinese" : "English");
  return {
    quote: draft.trim().slice(0, 200),
    why:
      `this scene is written in ${name(actual)} while the book is in ` +
      `${name(convention.script)}, established by its first committed scene. A ` +
      `manuscript that changes language partway is graded as one that changes ` +
      `language partway — rewrite this scene in ${name(convention.script)}`,
  };
}

export interface OrthographyDrift {
  readonly quote: string;
  readonly why: string;
}

/** One sentence around a match, for a finding the writer can locate. */
function sentenceAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf(".", index - 1) + 1);
  const end = text.indexOf(".", index);
  return text.slice(start, end === -1 ? Math.min(text.length, index + 200) : end + 1).trim();
}

/**
 * Words in this draft that contradict the book's established convention.
 *
 * Only the wrong-system spellings are reported, and each one is a single word
 * with an unambiguous counterpart — so the fix is mechanical and the writer
 * cannot be sent looking for a judgement it has to make.
 */
export function findOrthographyDrift(
  draft: string,
  convention: OrthographyConvention,
): readonly OrthographyDrift[] {
  const out: OrthographyDrift[] = [];
  const seen = new Set<string>();
  for (const [gb, us] of PAIRS) {
    if (gb === us) continue;
    const wrong = convention.spelling === "british" ? us : gb;
    const right = convention.spelling === "british" ? gb : us;
    const re = new RegExp(`\\b${wrong}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(draft)) !== null) {
      if (seen.has(wrong)) break;
      seen.add(wrong);
      out.push({
        quote: sentenceAround(draft, m.index),
        why:
          `"${m[0]}" is ${convention.spelling === "british" ? "American" : "British"} spelling ` +
          `in a book written in ${convention.spelling === "british" ? "British" : "American"} ` +
          `English; the established form is "${right}"`,
      });
    }
  }
  return out;
}

/** How the convention is stated in the packet and in `novel/style/voice.md`. */
export function renderConvention(c: OrthographyConvention): string {
  const language =
    c.script === "han"
      ? "Language: Chinese. "
      : c.script === "latin"
        ? "Language: English. "
        : "";
  return (
    language +
    `Spelling: ${c.spelling === "british" ? "British" : "American"} English. ` +
    `Direct speech takes ${c.quotes} quotation marks. Established by the first ` +
    `committed scene and fixed for the whole book.`
  );
}
