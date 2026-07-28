/**
 * How long a piece of writing is, counted the way we are scored.
 *
 * ## Why this is not `text.split(/\s+/)`
 *
 * Because Chinese has no spaces, and half of LongBench-Write is Chinese. The
 * whitespace count reads a finished 2,000-character Chinese story as **twenty
 * words**, and that number does not stay in a log — it is the number the writer
 * is given as its target, the number the length checks compare against, and the
 * `attainment` a run reports. Measured on `runs-ch21/lbw066-ch`: a legitimate
 * 5,571-byte manuscript, about 1,850 characters against a 2,000-character
 * target, recorded as `20 words, attainment 0.01` and reported `done`.
 *
 * Two things made that survivable rather than obvious. The half-book rerun rule
 * added in 0.8.9 counts *scenes*, and this run committed every scene it planned,
 * so nothing flagged it. And the LongBench-Write scorer uses the official
 * counter, so the score was never wrong — only every decision the harness made
 * on the way there.
 *
 * ## The definition
 *
 * Verbatim from upstream `evaluation/pred.py`: CJK codepoints plus Latin word
 * tokens, summed. So a Chinese and an English prompt that both say "2000 words"
 * are asking for different amounts of text, which is upstream's choice and not
 * something to correct here — the point of matching it exactly is that our
 * length compliance and theirs mean the same thing.
 *
 * The parallel lane hit this first and fixed it on their side
 * (`experiments/longbench-write/lbw_systems.py`), which is why the regex is
 * transcribed rather than invented.
 */

const CJK = /[\u4e00-\u9fff]/g;
const LATIN_WORD = /\b[a-zA-Z]+\b/g;

export function countWords(text: string): number {
  if (!text) return 0;
  return (text.match(CJK)?.length ?? 0) + (text.match(LATIN_WORD)?.length ?? 0);
}

/**
 * Whether a text is counted by character rather than by space-separated token.
 *
 * Reported alongside a run's word counts so a reader can tell a 2,000-word
 * English target from a 2,000-character Chinese one without inspecting the
 * prose, and so a future length bug of this shape is visible in the artefact.
 */
export function isCjkDominant(text: string): boolean {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.match(LATIN_WORD)?.length ?? 0;
  return cjk > latin;
}
