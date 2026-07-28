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

export interface OrthographyConvention {
  readonly spelling: Orthography;
  /** Which quotation mark opens direct speech, as observed. */
  readonly quotes: "double" | "single";
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
  return (
    `Spelling: ${c.spelling === "british" ? "British" : "American"} English. ` +
    `Direct speech takes ${c.quotes} quotation marks. Established by the first ` +
    `committed scene and fixed for the whole book.`
  );
}
