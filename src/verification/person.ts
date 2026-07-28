/**
 * Narrative person, checked mechanically against what the plan declared.
 *
 * ## Why this is not left to the model verifier
 *
 * LiveNovelBench measured our first 20,000-word manuscript at **4.93 consistency
 * errors per 10,000 words — worst of the nine systems at that tier** — and
 * **seven of its nine errors were `perspective_confusions`**: narration sliding
 * between a collective "we" and close third on Rue.
 *
 * Every one of those seven originated in scenes 1–3 of 17, and six of the seven
 * had *both sides inside the same scene*, 18 to 167 words apart. One pair is a
 * single sentence:
 *
 *     The board under the entry light showed **our** names in their neat column
 *     and gave **Rue** a particular, domestic kind of relief.
 *
 * So the evidence was never far away, or spread across a book, or hidden behind
 * an index lookup. It was in the draft the verifier was holding. Across those
 * seventeen scenes the model verifier called the consistency tool **twice** and
 * the craft tool seventeen times, and for s-001 it produced one round-trip and
 * no tool calls at all. It reviewed the scene with five of the nine errors in it
 * and reported three craft findings and zero contradictions.
 *
 * Two things had told it not to bother. `perspective_confusions` was tiered
 * `stylistic` — "a property of the prose itself… the most subjective; never a
 * hard block" — so it could not stop a scene even if reported; and
 * `novel/style/voice.md`, the file its own brief names for checking register
 * drift, still held the seed text saying the voice was not settled yet.
 *
 * ## Why a regex is the right instrument here
 *
 * The blatant case is decidable without judgement: the plan declares third
 * person, a narration sentence says "we", and those cannot both be right. Scored
 * against the judge's own findings, this recovers **7 of 7** at 5.47 hits per 10k
 * words against a ground truth of 3.83, while the manuscripts the same judge
 * measured near-clean produce 0.00–1.91.
 *
 * It deliberately only fires on the direction that is decidable. A first-person
 * narrator legitimately says "we" about a group they belong to and describes
 * other people in the third person all day, so nothing is claimed there.
 */

export interface DeclaredVoice {
  /** Verbatim from the plan, e.g. `third person limited, Rue`. */
  readonly person: string;
  readonly tense: string;
}

export interface PersonDrift {
  /** The narration sentence that contradicts the declared person. */
  readonly quote: string;
  /** Which pronoun class was found where it cannot be. */
  readonly why: string;
}

/**
 * Quoted speech, blanked before the scan.
 *
 * Characters say "we". Counting dialogue is the obvious way to build a detector
 * that fires on every page, and it is not hypothetical: pairing the quote marks
 * as a single character class let a closing curly quote open a new span, which
 * left whole speeches in the narration and took the rate to 43.78 per 10k words
 * against a ground truth of 3.83.
 */
const QUOTE_PAIRS: readonly RegExp[] = [
  /\u201c[^\u201c\u201d]*\u201d/g,
  /"[^"]*"/g,
  /\u2018[^\u2018\u2019]*\u2019/g,
];

const FIRST_PLURAL = /\b(we|us|our|ours|ourselves)\b/i;
const FIRST_SINGULAR = /\b(I|me|my|mine|myself)\b/;

function stripDialogue(text: string): string {
  let out = text;
  for (const q of QUOTE_PAIRS) {
    out = out.replace(q, (m) => " ".repeat(m.length));
  }
  return out;
}

function sentences(text: string): readonly string[] {
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/** `third` when the declaration says so, and only then is anything decidable. */
export function declaredPersonKind(person: string): "first" | "second" | "third" {
  const p = person.toLowerCase();
  if (p.includes("first person")) return "first";
  if (p.includes("second person")) return "second";
  return "third";
}

/**
 * Narration sentences that the declared person forbids.
 *
 * Capped by the caller, not here: a scene that drifts in twenty sentences is one
 * defect with twenty symptoms, and reporting twenty findings would consume the
 * repair budget on a single instruction the writer only needs once.
 */
export function findPersonDrift(prose: string, voice: DeclaredVoice): readonly PersonDrift[] {
  if (declaredPersonKind(voice.person) !== "third") return [];
  const drifts: PersonDrift[] = [];
  for (const sentence of sentences(stripDialogue(prose))) {
    if (FIRST_PLURAL.test(sentence)) {
      drifts.push({
        quote: sentence,
        why: "first-person plural in narration declared third person",
      });
    } else if (FIRST_SINGULAR.test(sentence)) {
      drifts.push({
        quote: sentence,
        why: "first-person singular in narration declared third person",
      });
    }
  }
  return drifts;
}
