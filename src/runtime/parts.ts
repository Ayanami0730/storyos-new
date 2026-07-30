/**
 * A count of parts the request states outright, when it states one.
 *
 * The scene count is derived from the target length, which is right for "write a
 * 20,000-word novel" and wrong the moment the request names its own structure. On
 * `lbw068` — *创作五篇关于"独自旅行去日本"的日记* — the plan was four scenes
 * because 2,000 words at the 500-word floor is four, so the manuscript carried
 * four diary entries. The frozen judge's first sentence about it was *"只有四篇
 * 日记，缺第五篇"*, and it scored 2.67 against agentwrite's 4.17 on a task whose
 * required structure was stated in eight characters. `lbw112` (共五幕) and
 * `lbw115` (a 50-page novel) are the same shape.
 *
 * Deliberately narrow, because a wrong count here is worse than none: it would
 * force a structure the task never asked for. So a numeral counts only when it is
 * bound to a unit that names a *part of a work*, never to characters, days, words
 * or pages — 五个人 is a cast, not a structure, and it appears in the same
 * sentence as 共五幕 on `lbw112`.
 */

/** Chinese numerals up to twenty, which is past any plausible part count. */
const HAN_NUMERALS: Readonly<Record<string, number>> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

const EN_NUMERALS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Units that name a division of the work itself. */
const HAN_UNITS = "篇|幕|章|回|部分|节|折|集";
const EN_UNITS =
  "chapters?|acts?|parts?|sections?|scenes?|episodes?|entries|entry|diary entries|" +
  "diaries|letters?|vignettes?|installments?|instalments?";

function hanNumber(text: string): number | null {
  // 十五 / 二十 as well as 五, since a part count can plausibly reach the teens.
  const m = /^(十)?([一二两三四五六七八九])?(十)?([一二两三四五六七八九])?$/.exec(text);
  if (!m) return null;
  if (text === "十") return 10;
  if (m[1]) return 10 + (m[2] ? HAN_NUMERALS[m[2]]! : 0);
  if (m[3]) return (m[2] ? HAN_NUMERALS[m[2]]! : 1) * 10 + (m[4] ? HAN_NUMERALS[m[4]]! : 0);
  return m[2] ? HAN_NUMERALS[m[2]]! : null;
}

export interface RequestedParts {
  readonly count: number;
  /** The phrase it was read from, for the log and the plan brief. */
  readonly quote: string;
}

/**
 * The largest stated part count, or null.
 *
 * Largest rather than first: a request that says *五篇日记* once and *每篇* three
 * times should be read as five, and taking the maximum is stable under repetition
 * where taking the first is stable only under a particular word order.
 */
export function requestedParts(request: string): RequestedParts | null {
  let best: RequestedParts | null = null;
  const consider = (count: number, quote: string) => {
    if (count < 2 || count > 20) return;
    if (!best || count > best.count) best = { count, quote: quote.trim() };
  };

  const han = new RegExp(`(?:共|一共|总共)?\\s*([零一二两三四五六七八九十]{1,3})\\s*(${HAN_UNITS})`, "g");
  for (const m of request.matchAll(han)) {
    const n = hanNumber(m[1]!);
    if (n !== null) consider(n, m[0]!);
  }

  const hanDigits = new RegExp(`(?:共|一共|总共)?\\s*(\\d{1,2})\\s*(${HAN_UNITS})`, "g");
  for (const m of request.matchAll(hanDigits)) consider(Number(m[1]), m[0]!);

  const en = new RegExp(`\\b(\\d{1,2}|${Object.keys(EN_NUMERALS).join("|")})\\s+(${EN_UNITS})\\b`, "gi");
  for (const m of request.matchAll(en)) {
    const raw = m[1]!.toLowerCase();
    consider(EN_NUMERALS[raw] ?? Number(raw), m[0]!);
  }

  return best;
}

/**
 * How thin a scene may be when the request is the thing asking for it.
 *
 * The general floor is 500 words, and it is there because a 500-word task written
 * as four 125-word scenes scored the best length compliance in its table and the
 * worst quality. That reasoning is about a count *we* derived. A request that says
 * 五篇 at 2,000 words has told us its parts are 400 words, and 400 words is a diary
 * entry — refusing it produces four entries where five were asked for, which is
 * the defect this exists to prevent. Same distinction the scene-count floor
 * already makes between a default and an explicit argument.
 */
const STATED_PART_MIN_WORDS = 250;

/**
 * The scene count to plan for, given the request and the length-derived default.
 *
 * A stated part count wins, but only while each part can still be a scene rather
 * than a fragment. Below that the derived count stands and the division becomes
 * the writer's to make inside a scene, which is the smaller error.
 */
export function sceneCountForRequest(
  derived: number,
  targetWords: number,
  request: string,
  _minWordsPerScene: number,
): { readonly count: number; readonly parts: RequestedParts | null } {
  const parts = requestedParts(request);
  if (!parts) return { count: derived, parts: null };
  if (targetWords / parts.count < STATED_PART_MIN_WORDS) return { count: derived, parts };
  return { count: parts.count, parts };
}
