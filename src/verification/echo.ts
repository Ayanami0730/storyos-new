/**
 * Restatement at short range: the same beat narrated twice.
 *
 * `style_shifts` is the largest external consistency subtype charged against us
 * (18 of ~80 kept instances at 60k), and reading the detector's own instances is
 * what identified it. Its `error_element` values are "duplicated scene exit and
 * narrative restart", "duplicated physical action", "duplicated scene entry", and
 * the pairs sit 94 to 800 words apart — inside one scene or across its seam:
 *
 *   She left Vault Ivy with the ledger cupped against her ribs…
 *   She left Vault Ivy with the ledger against her chest and…            (94 words)
 *
 *   Mira left the ring on the blotter until the Registrar appeared and took it
 *   away with the care of someone handling a grave.
 *   The Registrar appeared and took it away with the care of someone handling a
 *   grave; the fingers that received it…                                (304 words)
 *
 * Nothing could catch these. `copiedFromPacket` compares a draft against its
 * packet, so it sees a scene quoting an *earlier* scene and not a scene quoting
 * *itself*; the craft axis has `restates_prior_scene`, but that is an LLM
 * judgement about whole scenes and fired 2–3 times per 25-scene run.
 *
 * What is mechanical here is the shared run of words, so that is all this checks.
 * Two of the four instances above repeat 7 and 16 consecutive words; the other two
 * are semantic restatements with almost no shared vocabulary and stay with the
 * verifier, where a judgement belongs.
 */

export interface Echo {
  /** The later occurrence, as a sentence of the draft. */
  readonly quote: string;
  /** The earlier one it repeats. */
  readonly earlier: string;
  readonly run: string;
  readonly runWords: number;
  readonly distanceWords: number;
  readonly from: "this scene" | "the preceding scene";
}

/**
 * Twelve words, and sixteen characters where the unit has no word boundary.
 *
 * Calibrated on 551 committed scenes (`smoke/calibrate-echo.py`) rather than
 * chosen. Seven words is where the shortest measured instance sits, and it fires
 * on 21% of scenes — with visible false positives, because at that length a
 * repeated run is often a deliberate callback ("let it be seen and not spoken of",
 * spoken back by a character 2,300 words later) or a legal formula a document
 * restates on purpose. Twelve fires on 7% of scenes, 0.11 findings per scene, and
 * what it catches at that length is unambiguous: a duplicated COMLOG header, a
 * whole sentence repeated verbatim.
 *
 * So the shortest class is deliberately left to the verifier. A false positive
 * costs a repair round and damages prose that was working, which is the failure
 * that cost this project 8.4 points once; a false negative costs one instance in a
 * book.
 */
const MIN_RUN_LATIN = 12;
const MIN_RUN_HAN = 16;

/** A run of function words is a grammatical accident, not a repeated beat. */
const MIN_CONTENT_LATIN = 3;
const MIN_DISTINCT_HAN = 6;

const STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "be", "been", "but", "by", "for", "from", "had",
  "has", "have", "he", "her", "him", "his", "i", "in", "into", "is", "it", "its",
  "not", "of", "on", "or", "she", "so", "that", "the", "their", "them", "then",
  "there", "they", "this", "to", "up", "was", "were", "what", "when", "which",
  "who", "will", "with", "would", "you", "your",
]);

const HAN = /[\u4e00-\u9fff]/;

interface Tok {
  readonly norm: string;
  readonly at: number;
  readonly han: boolean;
}

function tokenise(text: string): Tok[] {
  const out: Tok[] = [];
  const words = /[\p{L}\p{N}][\p{L}\p{N}'’\u2011-]*/gu;
  let m: RegExpExecArray | null;
  while ((m = words.exec(text)) !== null) {
    // One match can straddle scripts ("GPT模型"), and Han characters are their
    // own tokens while Latin runs are one.
    const segments = m[0].match(/[\u4e00-\u9fff]|[^\u4e00-\u9fff]+/gu) ?? [];
    let offset = m.index;
    for (const segment of segments) {
      if (HAN.test(segment)) {
        out.push({ norm: segment, at: offset, han: true });
      } else if (/[\p{L}\p{N}]/u.test(segment)) {
        out.push({ norm: segment.toLowerCase(), at: offset, han: false });
      }
      offset += segment.length;
    }
  }
  return out;
}

function sentenceAt(text: string, at: number, limit = 300): string {
  const ends = ".!?。！？\n";
  let start = at;
  while (start > 0 && !ends.includes(text[start - 1]!)) start -= 1;
  let end = at;
  while (end < text.length && !ends.includes(text[end]!)) end += 1;
  const sentence = text.slice(start, Math.min(end + 1, text.length)).trim();
  return sentence.length > limit ? `${sentence.slice(0, limit)}…` : sentence;
}

/** Is this run a repeated beat rather than a run of connective tissue? */
function carriesContent(run: readonly Tok[], han: boolean): boolean {
  if (han) return new Set(run.map((t) => t.norm)).size >= MIN_DISTINCT_HAN;
  return run.filter((t) => !STOPWORDS.has(t.norm)).length >= MIN_CONTENT_LATIN;
}

export function findEchoes(
  draft: string,
  options: {
    readonly preceding?: string;
    readonly max?: number;
  } = {},
): readonly Echo[] {
  const draftTokens = tokenise(draft);
  if (draftTokens.length === 0) return [];
  const han = draftTokens.filter((t) => t.han).length > draftTokens.length / 2;
  const minRun = han ? MIN_RUN_HAN : MIN_RUN_LATIN;
  if (draftTokens.length < minRun) return [];

  const precedingText = options.preceding ?? "";
  const precedingTokens = precedingText ? tokenise(precedingText) : [];

  const join = (tokens: readonly Tok[]) =>
    tokens.map((t) => t.norm).join(han ? "" : " ");

  /** run key -> where it was first seen. */
  const firstSeen = new Map<string, { index: number; from: "draft" | "preceding" }>();
  for (let i = 0; i + minRun <= precedingTokens.length; i += 1) {
    const key = join(precedingTokens.slice(i, i + minRun));
    if (!firstSeen.has(key)) firstSeen.set(key, { index: i, from: "preceding" });
  }

  const echoes: Echo[] = [];
  const reported = new Set<string>();
  for (let i = 0; i + minRun <= draftTokens.length; i += 1) {
    const key = join(draftTokens.slice(i, i + minRun));
    const seen = firstSeen.get(key);
    if (!seen) {
      firstSeen.set(key, { index: i, from: "draft" });
      continue;
    }
    // An overlapping self-match is one phrase, not two occurrences of it.
    if (seen.from === "draft" && i - seen.index < minRun) continue;

    const earlierTokens = seen.from === "draft" ? draftTokens : precedingTokens;
    const earlierText = seen.from === "draft" ? draft : precedingText;
    let length = minRun;
    while (
      i + length < draftTokens.length &&
      seen.index + length < earlierTokens.length &&
      draftTokens[i + length]!.norm === earlierTokens[seen.index + length]!.norm
    ) {
      length += 1;
    }

    const run = draftTokens.slice(i, i + length);
    if (carriesContent(run, han) && !reported.has(key)) {
      reported.add(key);
      echoes.push({
        quote: sentenceAt(draft, draftTokens[i]!.at),
        earlier: sentenceAt(earlierText, earlierTokens[seen.index]!.at),
        run: join(run),
        runWords: length,
        distanceWords:
          seen.from === "draft"
            ? i - seen.index
            : precedingTokens.length - seen.index + i,
        from: seen.from === "draft" ? "this scene" : "the preceding scene",
      });
    }
    // Past the run, so one repeated passage is one finding rather than a finding
    // per position inside it.
    i += length - 1;
  }

  return echoes
    .sort((a, b) => b.runWords - a.runWords)
    .slice(0, options.max ?? echoes.length);
}
