/**
 * The harness version, stamped into every run.
 *
 * A version number is only worth having if an artefact can tell you which one
 * produced it. Every `summary.json` and every trace bundle carries this, so a
 * result found six months later is attributable without archaeology — and so
 * two results can be compared knowing whether they came from the same system.
 *
 * Bump `VERSION` when behaviour changes in a way that could move a number. The
 * things that qualify are not the obvious ones: a prompt edit moves numbers, a
 * refactor with identical prompts usually does not, and a fixed accounting bug
 * moves them a great deal.
 */

/** Semantic version of the harness. */
export const VERSION = "0.9.13";

/**
 * What this version is, in one line, for a reader who has only the artefact.
 *
 * Not a changelog — `git log` is the changelog. This is the sentence that tells
 * someone reading a six-month-old `summary.json` what kind of system produced
 * it, because "0.4.0" alone will mean nothing to them.
 */
export const VERSION_NOTE =
  "orchestrator-driven scene loop with per-scene compute allocated by position in " +
  "the story (2/3/5 repair rounds and follow-ups across the opening, middle and " +
  "final 40%, with recall depth 1/2/3), a narrative person and tense declared in the plan and " +
  "carried as a hard constraint in every packet, path-addressed artefacts, OS-enforced " +
  "write gate (docker read-only mount), cost-triggered level-1 compaction, " +
  "baseline-comparable token accounting (input+output, cache reads excluded), and a " +
  "per-scene verifier session; the verifier runs the same gpt-5-mini backbone as every " +
  "other role and every baseline, with cross-family available as an ablation, and " +
  "checks two axes — ConStory consistency subtypes and a craft axis distilled from the " +
  "LongBench-Write and LongStoryEval rubrics — against a deterministically assembled " +
  "claim-by-claim comparison with canon";

/**
 * Behaviours that could move a measured number, and when they landed.
 *
 * Kept because the most confusing kind of result is one produced by a version
 * you cannot characterise. Four of these were accounting or plumbing bugs whose
 * fixes changed numbers by large factors, so a run from before them is not
 * comparable with one from after, no matter how similar the configuration looks.
 */
export const VERSION_HISTORY: readonly {
  readonly version: string;
  readonly note: string;
}[] = [
  {
    version: "0.9.13",
    note:
      "The orchestrator's plan retry clears its session first, which the writer's retry has done " +
      "since 0.9.7 and this one did not. Measured on `runs-40kv2/lnbcustom-mystery-whidbey`: " +
      "three attempts returned `I'm sorry, but I cannot assist with that request.` verbatim in " +
      "**51 seconds** and the cell produced no plan and no manuscript \u2014 fast identical " +
      "wording is what asking again inside a refused conversation looks like from outside. That " +
      "a refusal is a session state rather than a property of the premise is already measured: " +
      "`a-far-flung-life-ch24` refused on its first reply and then planned normally on a fresh " +
      "sample. Resetting is safe for the schema-failure case too, which is the one that appears " +
      "to need the history \u2014 `retryAsk` quotes the last reply and names all six required " +
      "top-level fields in the prompt, and it does that because the validator's own message read " +
      "as though `world_rules` were nested and the model deleted half its scenes to satisfy it. " +
      "The corrective information is in the ask, not the transcript.",
  },
  {
    version: "0.9.12",
    note:
      "`Connection error.` counts as a transport failure and is retried. Measured on " +
      "`runs-lbw21/lbw106`: the orchestrator's first turn died 65 seconds in with " +
      "`TurnFailed: orchestrator's turn failed after 1 attempt(s): Connection error.`, and the " +
      "cell produced no plan and no manuscript at all. This is the third wording of one event " +
      "to be added one at a time \u2014 `ECONNRESET` and `socket hang up` name it from the " +
      "socket, `Stream ended without finish_reason` from the stream (0.9.9), and this is what " +
      "the OpenAI-compatible client says when it has no errno to hand. Also covered: " +
      "`fetch failed`, `ECONNREFUSED`, `connection closed`, `premature close`. The shape of " +
      "this fix is wrong and is recorded as wrong: a classifier that reads a client's prose " +
      "will keep missing the next phrasing, and the version that stops needing edits would " +
      "read a typed cause instead. Kept as a pattern for now because the deadline is closer " +
      "than the refactor is safe.",
  },
  {
    version: "0.9.11",
    note:
      "0.9.10 shipped a checker that could not run, and the way it failed was worse than the " +
      "defect it was fixing. `style_shifts` is a `stylistic` subtype, which the taxonomy holds " +
      "non-blocking on the grounds that \u201ca stylistic judgement is too soft to refuse prose " +
      "over\u201d; the orthography check constructed it with `severity: \"error\"`, and " +
      "`makeFinding` refuses that pairing. The throw landed inside `verifyDeterministic`, which " +
      "`verify()` calls **after** moving the scene to VALIDATING \u2014 a state `verify()` itself " +
      "refuses to re-enter. So every later verification call came back \u201cthere is no fresh " +
      "draft to check\u201d, index-manager would not commit without an approval, and the " +
      "orchestrator abandoned the scene. The blast radius: **2 of the first 5 runs on 0.9.10 " +
      "delivered 1 of 4 planned scenes** (attainment 0.28 and 0.35), against **zero occurrences " +
      "of that state in the 60 runs from 0.7.1 through 0.9.7**, and the batch's own rerun hit it " +
      "again because the trigger is the manuscript's spelling rather than chance. It survived 540 " +
      "tests because every orthography test called the pure functions; none drove the layer that " +
      "runs them. Three fixes, and the first is the least important. (1) A deterministic checker " +
      "may block on a subtype the model verifier may only warn about, because the distinction the " +
      "taxonomy is protecting is judgement against comparison \u2014 `labour` against `labor` is " +
      "a fact with one fix, and a warning would leave it on the page, which was the whole point. " +
      "The tiers themselves are untouched, so nothing about the frozen metric or the model path " +
      "changes. (2) A crash in the deterministic layer no longer strands a scene: it degrades to " +
      "the trade already made for an unreachable verifier \u2014 the checks that ran stand, the " +
      "scene proceeds, and it is recorded. A defect in our own checker must not be able to look " +
      "like a defect in the manuscript. (3) `deterministic_failures` goes into `summary.json` " +
      "beside `backfill_failures`, and failed scenes now carry their warnings at all \u2014 they " +
      "did not, so a crash was reported only on scenes that survived it, which is the one case it " +
      "could not. Same shape as the index-manager incident four versions earlier: the mechanism " +
      "was dead, every run said `done`, and nothing counted it.",
  },
  {
    version: "0.9.10",
    note:
      "one book, one spelling \u2014 and harness notes stop reaching the page. Both are the " +
      "subtype that took over the moment `perspective_confusions` was fixed. Measured across " +
      "ten manuscripts on the repaired harness, `style_shifts` is the **largest consistency " +
      "subtype, 30 of 87 kept instances, 1.83 per 10k**, while perspective drift fell from 7 in " +
      "one pre-fix manuscript to **1 across 163,000 words**. Reading the instances, none of it " +
      "is a literary judgement. Five of six on `task-literary-yesteryear` are " +
      "`memorised`/`memorized`, `labour`/`labor`, `realised`/`realized`, " +
      "`practised`/`practiced`, `flavour`/`flavor`, plus one quotation convention \u2014 the " +
      "writer resets per scene, nothing had ever decided the orthography, so eight scenes each " +
      "chose. That is the pre-0.8.0 narrative-person defect one layer down, so it gets the same " +
      "treatment and no plan field: the first committed scene with evidence establishes the " +
      "convention, it is written into `novel/style/voice.md` where every role is told to look, " +
      "and the deterministic layer reports later scenes that contradict it, capped at two " +
      "findings because four wrong-system spellings are one habit. Deriving it rather than " +
      "planning it is deliberate \u2014 `submit_plan` already refuses often enough to cost " +
      "planning round-trips, and a convention is not a judgement worth a model call. The rest " +
      "are the writer leaving its own bookkeeping in the manuscript: `[staging folio A-0001]`, " +
      "`[bracketed provenance: unnamed in builder]`, `[see s-001]`, `(staging: invented by " +
      "writer)`, and index ids used as nouns \u2014 `press_podium`, `roster_sheet`. Same family " +
      "as 0.7.3, where the writer quoted its packet, and a different channel because here it " +
      "composes the note itself; so `write_staged_scene` refuses it beside the verbatim-copy " +
      "check, pointing at `propose_state_delta` as the channel built for provenance. Narrow by " +
      "construction: replayed over all twelve finished manuscripts it refuses exactly the two " +
      "that carry the defect and passes the ten that do not.",
  },
  {
    version: "0.9.9",
    note:
      "a stream that closes without saying why is retried. `Stream ended without finish_reason` " +
      "is the same transport accident as the JSON truncation retried since 0.9.x, with none of " +
      "the JSON wording, so no matcher covered it. Measured on `lnbcustom-horror-molka-ch24`: " +
      "its planning turn spent **thirty-one minutes** — six request-level attempts — and then " +
      "died `TurnFailed after 1 attempt(s)`, killing the cell, because the turn-level " +
      "classifier did not recognise the message. That cell had already failed twice for two " +
      "other reasons, each a different mechanism. A stream that stops without a finish reason " +
      "is a transport failure by definition: there is no differently-phrased request that " +
      "avoids it, which is the classifier's standing argument for retrying a 429.",
  },
  {
    version: "0.9.8",
    note:
      "the orchestrator is told where the book will land, not just where it is. It already " +
      "received words committed, the target and the remainder, and that was not enough, because " +
      "the decision needs an arithmetic nothing performed: a scene *target* is what the writer " +
      "was asked for and delivery is a different number. Measured across the chapter-length arm, " +
      "where scenes are asked for 2,400\u20133,600 words, **delivery settles near 2,050 a scene " +
      "whatever the ask** \u2014 so `lnb20k-crows-ch` planned six scenes for 20,000 words and " +
      "finished at 12,305, **attainment 0.61**, with every individual scene looking fine on the " +
      "way there. Nothing in the run could notice, because the only actor able to add scenes was " +
      "never shown the projection. The brief now averages the committed scenes, states where that " +
      "rate finishes the book, and names `update_plan` as the lever that does not depend on the " +
      "writer changing its behaviour \u2014 adding scenes already works and was never used: " +
      "`update_plan` returns the scenes ahead and may return more of them, and the scene loop " +
      "re-reads the plan's length every iteration, so a scene appended at scene four does get " +
      "written. Silent below two committed scenes, because one scene is not a rate, and silent " +
      "within 10% of target, because a block printed on every scene of every run is one the " +
      "reader learns to skip. It also says outright that padding costs the quality dimensions, " +
      "since the cheap way to satisfy a length instruction is filler.",
  },
  {
    version: "0.9.7",
    note:
      "a planning turn that ends without a plan is asked again, three times, and only then a " +
      "failure. It was fatal on the first occurrence, and both causes measured in one batch are " +
      "worth another sample. On `lnbcustom-horror-molka-ch24` the orchestrator called " +
      "`submit_plan` twice, was refused both times for **omitting `tense` and `world_rules`**, " +
      "and then answered *\"I'm sorry, but I cannot assist with that request\"* \u2014 a model that " +
      "is stuck, not one with an objection. Worse, its response to the refusal was to cut the " +
      "scene list from eight to four, because the validator said `world_rules: must have " +
      "required properties world_rules, tense`, which reads as though `world_rules` were an " +
      "object missing sub-properties. So the re-ask names the six required top-level fields and " +
      "says outright not to shorten the plan to get past a validation error. On " +
      "`lnbcustom-historical-a-far-flung-life-ch24` that same sentence was the *first* reply " +
      "with no tool call at all, on a premise about a bereaved family \u2014 a content refusal, " +
      "which is partly a sampling accident and is the other reason to resample. Three attempts, " +
      "because a premise refused three times running is a fact about the task worth recording " +
      "rather than retrying forever, and the error now carries the last reply: without it a " +
      "content refusal and a schema loop are the same line in the batch log, which is how both " +
      "of these were first read as one thing. The same sentence cost a whole scene on the " +
      "writer's side, and there the retry already existed: on `lbw081-ch` the writer answered it " +
      "**eight times running** \u2014 four scene attempts times the two asks each makes \u2014 and the " +
      "run delivered 0 of 1 scenes, while that same task on that same backbone had produced " +
      "2,679 words at attainment 0.96 two versions earlier. So the refusal is a state the " +
      "session reached rather than a property of the request, and a retry inside that session " +
      "can only draw the same reply: the writer's transcript is now cleared before the scene-" +
      "level retry, which is safe because the retry re-sends the whole packet and a follow-up " +
      "answer already lives in the packet file. The comment justifying that retry called a " +
      "failed turn \"retryable, of the same kind as a 429\" \u2014 the difference it missed is that " +
      "a 429 is not in the conversation.",
  },
  {
    version: "0.9.6",
    note:
      "the index-manager can write the index again. `fold_scene` was added to the factory in " +
      "0.9.1 and never to the persona allowlist, so `allowlistMismatch` refused the role at " +
      "construction \u2014 correctly, by its own argument \u2014 on **every scene of every run for " +
      "four versions**. Measured across 26 runs on 0.9.1\u20130.9.4: **zero state entries, zero " +
      "beliefs, zero relations, zero events, in all of them**, against 11\u2013101 state entries " +
      "in all 15 runs from 0.7.1 to 0.8.2. On disk each character kept only `profile.yaml` and " +
      "`relations/` was empty, so the committed index held identities and nothing else. The " +
      "writer was not blind \u2014 P0 and P1 come from the in-memory canon the deltas build, and " +
      "`canon_facts` stayed at 3\u2013148, which is exactly why this looked like a normal run \u2014 " +
      "but everything the context-builder searches for was absent, which is what its 2\u20135 " +
      "recorded gaps per scene were reporting. Every number measured on 0.9.1\u20130.9.4 is a " +
      "number for a harness with its central mechanism switched off, the chapter-length A/B " +
      "included. Three things changed, and the permission is the least of them. The role now " +
      "lists the tool. `allowlistMismatch` is tested against the tools the factory *actually " +
      "builds*, because the three tests that existed compared the list with `toolNamesFor` \u2014 " +
      "the list itself \u2014 and could not fail on this drift by construction. And a backfill " +
      "failing on **three consecutive scenes** now ends the run instead of warning: per-scene " +
      "tolerance is right for a transient failure and is what made a permanent one invisible, " +
      "since the scene commits anyway and the batch reads `done`. `backfill_failures` is in " +
      "every summary beside `canon_facts`, which is the pair that distinguishes the two cases. " +
      "Separately, the cost column stopped reading **$0.00** on the internal gateway: that route " +
      "needs `openai/gpt-5-mini` to reach an unsaturated upstream group, the prefixed name " +
      "matched no rate, and the run reported zero with the model filed under `unpriced`. A zero " +
      "that means \"unknown\" is the same failure as reading a Chinese manuscript as twenty " +
      "words \u2014 it looks like a measurement. Only the vendor prefix is normalised; a name that " +
      "is genuinely unknown after stripping it still returns no rate, because nothing in that " +
      "table may be guessed.",
  },
  {
    version: "0.9.5",
    note:
      "a run in which no scene survived reports its failures instead of crashing. The global " +
      "pass refuses an empty span \u2014 correctly, for a direct caller, since auditing nothing " +
      "is a programming error \u2014 but the story loop reaches it unconditionally, so when the " +
      "last scene failed too the refusal travelled up as fatal. Measured on `lbw102-ch`, a " +
      "single-scene plan whose one scene failed: `exit 1`, `Error: a global pass needs at " +
      "least one scene of span`, and no record of *why* the scene failed. That is the exact " +
      "outcome the scene loop\'s own failure handling exists to prevent \u2014 its comment says a " +
      "failed scene does not stop the story because \"the failure rate is a result, and a " +
      "harness that halts on the first hard scene reports nothing at all\" \u2014 and the " +
      "all-scenes-failed case was the one path that contradicted it. `planRevisions` now " +
      "returns an empty plan for an empty span; `verifyGlobal` keeps its refusal. Also fixes " +
      "`VERSION_NOTE`, which was silently **truncated to 247 characters of 1,100**: a dropped " +
      "`+` mid-concatenation is not a syntax error, semicolon insertion ended the assignment " +
      "at the gap and the rest became a discarded expression, so the sentence stamped into " +
      "every summary stopped at \"declared in the plan and\" while typecheck, lint and a " +
      "`length > 100` assertion all passed.",
  },
  {
    version: "0.9.4",
    note:
      "the \"intent names an entity it does not list as present\" check applies to characters " +
      "only. Measured across 44 runs: it flagged **locations 197 times, objects 122 and " +
      "characters 94**, and **25 of 44 plans needed at least one retry** \u2014 " +
      "`lnb40k-fantasy-the-tapestry-of-fate` spent seven `submit_plan` calls with 107 scenes " +
      "flagged, and twice a run died outright with `the orchestrator produced no plan`. Two " +
      "thirds of that pressure was entities the rejection\'s own argument does not reach: it " +
      "says the writer only receives *state and beliefs* for what is present, and a location " +
      "has no beliefs. It also removed a false-positive class \u2014 the stem is the first " +
      "hyphen-separated segment, which is what lets `char-elias-warden` be found in an intent " +
      "saying \"Elias\", and it made `loc-windsor-castle` match every scene of a story *set in " +
      "Windsor* and `char-war-envoy` match \"the approaching war\". The character case the check " +
      "was built for is untouched. Planning round-trips are iteration speed, and this check was " +
      "spending up to five of them per run pushing back against 0.8.4\'s ceiling on how much a " +
      "scene may list.",
  },
  {
    version: "0.9.3",
    note:
      "words are counted the way the benchmarks count them. Ours was " +
      "`text.split(/\\s+/)`, and Chinese has no spaces \u2014 so a finished " +
      "1,850-character Chinese story was measured as **twenty words**. Three " +
      "LongBench-Write cells reported `done \u2014 1 scene(s) of 1 planned, 20 words` " +
      "against a 2,000-character target, and roughly half of that bench is Chinese. " +
      "The prose was never the problem and the score was never wrong (the scorer " +
      "uses the official counter) \u2014 what was wrong is every decision the harness " +
      "made on the way: the target handed to the writer, the length checks, the " +
      "`thin_for_its_length` craft check, and the `attainment` each run reports. " +
      "`runtime/words.ts` now transcribes upstream `evaluation/pred.py` \u2014 CJK " +
      "codepoints plus Latin word tokens \u2014 and every site measuring delivered " +
      "length uses it, including the packet budget, which is a proxy for how much " +
      "text an agent has to read and was reading a Chinese packet at a fiftieth of " +
      "its size. Separately, `classify` now reruns a run that committed every scene " +
      "it planned and still delivered under half its target: the scene-count rule " +
      "added in 0.8.9 is blind to that by construction, and it is a failure worth " +
      "catching whatever the cause.",
  },
  {
    version: "0.9.2",
    note:
      "the route that buys the tokens is selectable, and recorded. The reference gateway spent " +
      "a morning refusing us \u2014 a forty-minute `401 Invalid token` window that truncated three " +
      "runs to attainment 0.05\u20130.06, then sustained `429 \u2026 swedencentral has exceeded rate " +
      "limit` that killed four more during planning at concurrency **2**, because the quota is " +
      "shared with another lane on the same machine. `STORYOS_SUPPLY=zzz` points the provider " +
      "registration at an OpenAI-compatible endpoint serving the same model. Probed at rising " +
      "concurrency it took 1, 2, 4 and 8 parallel requests with **zero failures** and flat " +
      "latency (p50 3.5\u20135.0s, which is the reference gateway\'s own p50); at 12 and 16 the " +
      "median doubled to ~7.5s while throughput stopped rising, so eight is the knee. The " +
      "default is unchanged and stays the reference gateway, because every baseline in both " +
      "tables came through it and a run served by a different deployment of the same model " +
      "name is not automatically comparable \u2014 so the route lands in `summary.json`, an unknown " +
      "`STORYOS_SUPPLY` throws instead of falling back, and the model is looked up under the " +
      "provider that was actually registered. That last one is not hypothetical: registering " +
      "as `zhizengzeng` while still fetching `yuanshi-sg` killed all eight runs of the first " +
      "attempt at their first turn with `Unknown provider: unknown`.",
  },
  {
    version: "0.9.1",
    note:
      "three changes aimed at the round-trip count, which is what wall clock is made of. " +
      "(1) **`fold_scene`** takes a whole scene\'s index writes \u2014 identities, entities, state, " +
      "beliefs, relations, events, rhythm, promises, payoffs, retcons \u2014 in one call, applied " +
      "in dependency order, each section validated on its own so a bad entry costs that entry " +
      "and not the scene. Folding a scene used to mean `record_relation_phase` 29 times, " +
      "`append_event` 26, `append_state` 23, `append_beliefs` 22: **228 tool calls in 228 " +
      "replies** on a 20,000-word run, 24% of its wall clock. The array parameters were " +
      "already there but scoped to one character, which is a signature limit rather than a " +
      "choice the model was making \u2014 and this project has twice measured that signatures move " +
      "behaviour where instructions do not. The per-partition tools stay, for corrections; the " +
      "typed separation that stops a state observation being filed as identity is unchanged, " +
      "because each partition keeps its own field and validator. (2) **Concrete shell recipes " +
      "in the shared contract**, because ids are the links here and nothing said so: " +
      "`cat relations/char-rue--*.yaml` is every relation Rue is in, " +
      "`tail -n 3 characters/*/state.jsonl` is the current state of the entire cast in one " +
      "call. (3) **`--words-per-scene`**, the chapter-length arm: a scene is already the unit " +
      "of one packet, one writer call, one verifier pass and one commit, so 3,600 runs a third " +
      "as many of all four, and the arm is recorded in the summary. A test caught that the " +
      "floor of four was unconditional, so on a 2,000-word task the arm returned the control\'s " +
      "own plan \u2014 every LongBench-Write task is 500 to 3,500 words, so the whole experiment " +
      "would have measured as \"no effect\" there. An explicit length now outranks the floor; " +
      "the 500-word minimum still binds.",
  },
  {
    version: "0.9.0",
    note:
      "the index contract stopped lying about what a read costs. It said *\"read as much as " +
      "you need. The index is the cheap thing\"*, which is true in tokens and false in the " +
      "dimension that decides wall clock: a 20,000-word run made **703 sequential model " +
      "round-trips, 96% of them carrying exactly one tool call**, and the two roles that only " +
      "look things up \u2014 context-builder and index-manager \u2014 spent **64% of the run\'s wall " +
      "clock** without writing a word of prose. `read_index` has taken a list of paths since " +
      "0.7.6 and was called **once** in seventeen scenes, while the builder issued 78 " +
      "single-file `read`s; nothing had told it the list existed or why it mattered. The " +
      "contract now states the round-trip cost, names the batch signature, says independent " +
      "calls in one reply run in parallel, and points at the layout that makes one shell call " +
      "answer a whole question \u2014 ids are the links, so `relations/char-rue--*.yaml` is every " +
      "relation Rue is in. Timing is not the only thing this buys: the gateway fans requests " +
      "across upstream partitions that each hold their own prefix cache, so a round-trip is " +
      "also a fresh chance to land on a cold one. Measured within a single turn, cache hit " +
      "oscillates between 99% and 0% on an unchanged prefix, averaging 30\u201358% \u2014 fewer " +
      "round-trips is the only lever we hold over that.",
  },
  {
    version: "0.8.9",
    note:
      "a run that delivered less than half its scenes is rerun, not kept. The gateway lost " +
      "authentication for about forty minutes \u2014 `401 Invalid token`, on a key that answered " +
      "200 again afterwards \u2014 and three runs came back at **1/17, 2/30 and 2/32 scenes, " +
      "attainment 0.05\u20130.06**, each with `fatal: null` and `exit 0`, because every scene " +
      "after the first aborts individually and no single scene failure is fatal. They landed " +
      "in `done`, which is the state the batch skips, so the next invocation would have " +
      "preserved three one-scene stubs and reported nothing to do. Keeping a short run is the " +
      "right trade for a manuscript \u2014 five hours of work is not something a status " +
      "classifier should discard on its own \u2014 and a story with a twentieth of its scenes is " +
      "not one.",
  },
  {
    version: "0.8.8",
    note:
      "the narrative person is checked, not merely declared, and the subtype can block. " +
      "Tracing all nine consistency errors LiveNovelBench charged the first 20,000-word " +
      "manuscript with: **every one originates in scenes 1\u20133 of 17**, and six of the seven " +
      "`perspective_confusions` have *both sides inside the same scene*, 18 to 167 words apart " +
      "\u2014 one inside a single sentence, *\"The board \u2026 showed **our** names \u2026 and gave **Rue** " +
      "a particular, domestic kind of relief.\"* The evidence was in the draft the verifier was " +
      "holding. Across those seventeen scenes it called the consistency tool **twice** and the " +
      "craft tool seventeen times; on s-001 it produced one round-trip and no tool calls, and " +
      "on s-002, which contains five of the nine errors, three craft findings and zero " +
      "contradictions. Two things had told it not to bother: `perspective_confusions` was " +
      "tiered `stylistic` \u2014 *\"the most subjective; never a hard block\"* \u2014 so 78% of our " +
      "measured error mass sat in the one tier that cannot stop a scene, and " +
      "`novel/style/voice.md`, the file its brief names for register drift, still held its " +
      "seed text (fixed in 0.8.6). So the subtype moves to `explicit-pair`, and the " +
      "deterministic layer now takes the draft and the declared voice and reports narration " +
      "that contradicts it. Scored against the judge\'s own findings the check recovers **7 of " +
      "7** at 5.47 hits per 10k words against a ground truth of 3.83, while the manuscripts " +
      "the same judge measured near-clean give 0.00\u20131.91. Dialogue is blanked first \u2014 " +
      "characters say \"we\", and a first attempt that paired quote marks as one character class " +
      "ran to 43.78 per 10k. Capped at two findings per scene: nine drifting sentences are one " +
      "defect the writer needs told once, and the opening tier has two repair rounds.",
  },
  {
    version: "0.8.7",
    note:
      "an alternating viewpoint must say where it is allowed to switch. The 40,000-word " +
      "historical cell declared *\"third person limited, alternating between the Queen and the " +
      "Actress, past tense\"*, which passes every other check and still fails this tool\'s own " +
      "stated bar — the writer has to be able to check a sentence against it, and under that " +
      "declaration a sentence in either woman\'s head is correct anywhere in the book, " +
      "including mid-paragraph. That is exactly what the detector reports as " +
      "`perspective_confusions`, the subtype holding **seven of the nine** errors the voice " +
      "constraint exists to prevent. Naming the unit keeps the technique and restores the " +
      "check: \"one viewpoint per scene, alternating between the Queen and the Actress\" makes " +
      "every sentence answerable again, because the scene it sits in has an owner.",
  },
  {
    version: "0.8.6",
    note:
      "the declared voice is written to the file everything is told to read. Since 0.8.0 the " +
      "packet has carried `Narration: <person>, <tense> tense … decided for the whole book " +
      "before any of it was written and does not change`, citing `novel/style/voice.md` as its " +
      "source — while that file still held its seed text, *\"(Established by the first " +
      "committed scenes; the writer may propose changes.)\"*, which is the opposite claim at " +
      "the address the claim points to. It matters because of who reads it: the verifier\'s " +
      "brief sends it to this file by name to check register drift, and register drift is " +
      "**seven of the nine** consistency errors measured in the first 20,000-word manuscript " +
      "(4.93 per 10k words, worst of the nine systems at that tier). An agent asked to enforce " +
      "a constraint, sent to the file that holds it, and shown a note saying the constraint is " +
      "not settled yet, has been told there is nothing to enforce.",
  },
  {
    version: "0.8.5",
    note:
      "a gateway 401 is retried, and a run that does not write the book it planned says so. " +
      "Both 40,000-word runs returned `exit 0` with `fatal: null` at 28,186 and 27,427 words — " +
      "**attainment 0.70** — because the writer drew a mis-keyed upstream partition at s-021 " +
      "and s-023, `401: Access denied due to invalid subscription key or wrong API endpoint`, " +
      "and spent the scene's whole six-attempt allowance on it at one API attempt each; every " +
      "later scene aborted. The key was valid the whole time, and the proof is a third run on " +
      "the same key in the same window that absorbed **110** of these 401s and was still " +
      "producing scenes eleven hours later, against 124 and 113 in the two that died. Which " +
      "run dies is a question of which partition it draws, which is the same scheduling " +
      "accident the classifier already retries a 429 for. Matched narrowly on the message, so " +
      "a genuinely revoked key still fails fast. Separately, `classify` now marks a finished " +
      "run that committed fewer scenes than it planned, and the batch logs `done SHORT — … 23 " +
      "scene(s) of 32 planned, attainment 0.70`: the previous line read `done — 28,186 words, " +
      "23 scene(s)`, which is what a Table 1 cell would have been built from.",
  },
  {
    version: "0.8.4",
    note:
      "a scene card may no longer hold the whole book. The 60,000-word stress test planned " +
      "fifty-two scenes and declared the identical thirty-four ids — thirteen characters, " +
      "thirteen locations, eight objects — present in every one of them, each scene being " +
      "1,200 words. Two costs, both measured: P1 of the writer's packet is every present " +
      "character's state and beliefs and cannot be evicted, so it ran **2,609 tokens against " +
      "a median of ~700** in the two healthy 40k runs; and the writer was told on its card " +
      "that thirteen characters and thirteen locations were in a 1,200-word opening. The " +
      "cause was the guard on the other side: rejecting an intent that names an entity absent " +
      "from `present` tells the planner to *add* entities, and across fifty-two scenes the " +
      "cheapest way never to trip it again is to list everybody. So the check is now " +
      "symmetric — at most five locations per scene, and for plans of eight or more scenes a " +
      "median scene may not hold more than 70% of the entities the plan uses. Both thresholds " +
      "come from the twenty plans already on disk, where the most locations any scene " +
      "declared was four and long plans ran 17–33% cast share; replayed against all " +
      "twenty-one, the guard rejects exactly the pathological one.",
  },
  {
    version: "0.8.3",
    note:
      "a value that is a sentence stopped being compared by string equality. Measured on " +
      "`runs-r1/lbw079`: canon held `char-narrator.keeps_written_records = \"timestamps and " +
      "records events in notebook\"` and the scene declared `\"records timestamps and " +
      "findings in notebook\"` — the same fact reworded — and the continuity check reported it " +
      "as a **blocking** `quantitative_mismatches`, a subtype about counts, reached only " +
      "because the attribute matched no pattern and that is the fallback. This is the third " +
      "false positive of the family, after absences-as-contradictions and characters walking " +
      "somewhere. The taxonomy\'s comparisons are built for atomic facts, where two strings " +
      "really are two claims; a phrase describing behaviour has no canonical wording, so " +
      "restating it diffs on every scene it appears in and the writer cannot spend a repair " +
      "round usefully on it — it has no way to know which phrasing canon prefers. A " +
      "prose-shaped value (four words or more on either side) now degrades to a warning and " +
      "is handed to the verifier, which can read both and say whether the meaning moved. " +
      "Atomic values keep their teeth.",
  },
  {
    version: "0.8.2",
    note:
      "the level-2 fold is told what *this* role cannot recover. One prompt served all five, " +
      "which asks each of them to decide for itself what matters — the decision a summary is " +
      "least able to make, because it is written under length pressure and under pressure a " +
      "model compresses whatever is longest rather than whatever is load-bearing. What is " +
      "load-bearing differs completely by role and none of it is inferable from a generic " +
      "instruction: the context-builder\'s is the map it has built of where things live in " +
      "this book\'s index and which searches came back empty, the verifier\'s is the list of " +
      "false positives it was talked out of, the orchestrator\'s is why it revised the plan " +
      "and which committed scenes carry known defects. `ROLE_RETENTION` pairs each with what " +
      "the role may drop, and every `drop` names something re-readable from the index, which " +
      "is the same argument the shared contract makes about memory. This matters most for the " +
      "orchestrator now that the other four reset between scenes: it is resident by design, " +
      "reached 62k over seventeen scenes, and is the one role for which the fold is on the " +
      "critical path to a long book.",
  },
  {
    version: "0.8.1",
    note:
      "three defects the running 40k round would have hit. (1) **Batched follow-up questions " +
      "were answered by a framework error.** pi runs a batch of tool calls in parallel and " +
      "`ask_context_builder` never declared itself sequential, so the second question in one " +
      "reply arrived while the builder was mid-turn and came back `Agent is already processing " +
      "a prompt` — which the harness handed to the writer *as the answer*. Measured on " +
      "`runs-r1/lbw081`: five questions in one reply, one answered, four framework errors, and " +
      "the writer cannot tell the difference so it wrote the scene believing the index was " +
      "silent. Partly ours: v0.7.5 had just told every role to batch. The tool is now " +
      "sequential, `SHARED.md` carves delegation out of the batching advice, and a reply that " +
      "looks like a machine message is surfaced as a failure. (2) **All four specialists now " +
      "reset per scene.** Peak context at seventeen scenes: writer 200k (died), " +
      "context-builder 193k, index-manager 109k, orchestrator 62k. Growth is linear in scenes, " +
      "so at the 34-scene 40k tier the builder reaches ~380k and the index-manager ~220k and " +
      "both die where the writer did. Their work is per-scene by construction; only the " +
      "orchestrator holds the book. (3) The writer's prompt never named the verifier, the " +
      "repair loop, or its freedom to invent in the space the index does not describe — it now " +
      "does all three, and `SHARED.md` says which roles are cleared between scenes.",
  },
  {
    version: "0.8.0",
    note:
      "the first two findings from a 20,000-word manuscript, which is four times longer than " +
      "anything this harness had written. (1) **The narrative person is now declared and " +
      "carried.** LiveNovelBench\'s consistency audit found nine errors in 18,274 words and " +
      "**seven were `perspective_confusions`**: the narration drifting between a collective " +
      "first person and close third on the protagonist, scene by scene — *\"the list was " +
      "already up when we came in\"* against *\"Rue walked toward the ferry\"*. Nothing had " +
      "ever decided. `novel/style/voice.md` was seeded with *\"(Established by the first " +
      "committed scenes)\"* and the plan had no field, so seventeen scenes each chose. " +
      "`submit_plan` now requires `narrative_person` and `tense`, refuses a person it cannot " +
      "check a sentence against, and the pair rides in every packet as hard-required P0. " +
      "(2) **The writer\'s session resets per scene.** Its context grew 9,689 to 209,891 " +
      "tokens across fifteen scenes; level-1 compaction fired at 166k, 180k and 195k and lost " +
      "the race every time, because what grows is the prose the writer itself produced, not " +
      "the tool payloads compaction evicts. Level 2 has still never fired. Scenes 16 and 17 " +
      "died on the provider\'s message-token limit and were abandoned, so the run landed 15/17 " +
      "at 87% of target — and a 34-scene 40k story, which is the tier every baseline is scored " +
      "at, dies the same way around scene 16. Residency bought the writer a consistent voice, " +
      "and that argument is spent now that the voice is a declared constraint in front of it. " +
      "`--resident-all` restores both sessions as the ablation.",
  },
  {
    version: "0.7.7",
    note:
      "the dossier had the opposite of its intended effect and this undoes it. Verifier " +
      "round-trips per turn, with the tools used: **3.2** on 0.5.1 cross-family " +
      "(`write_findings` x18), **3.8** on 0.6.2 same-family (`read` x2, `read_index` x7, " +
      "`write_findings` x5), **1.8** on 0.7.3 with the dossier (`write_craft_finding` x4 and " +
      "nothing else). Reads went 9 to 0 and consistency findings went 5 to 0, on all three " +
      "reruns. Handing the verifier the claim-by-claim comparison for free did not free it to " +
      "do the expensive half of its job; it replaced it. The comparison covers only what the " +
      "writer *declared*, and the defects that cost most are the ones nobody declared — a " +
      "character acting on something they were never told, a span of time that cannot hold its " +
      "events. The brief now says this, with the numbers, and one explicit second ask fires on " +
      "any scene where the verifier read nothing and filed no consistency finding: \"no " +
      "contradictions\" from an agent that consulted nothing is a statement about the dossier, " +
      "not about the manuscript.",
  },
  {
    version: "0.7.6",
    note:
      "`read_index` takes a list of paths, charged as one read against the budget rather than " +
      "one per file. The batching instruction added in 0.7.5 worked for one role and failed for " +
      "another — the index-manager fell from 29.8 round-trips per turn to 4.0, the " +
      "context-builder rose from 22.5 to 31.0 — and an instruction one role follows and another " +
      "ignores is not a mechanism, so the signature is. Also corrects `probe-index-leak.py`, " +
      "which had been comparing the manuscript against an index that index-manager writes " +
      "*from* the manuscript: it now compares against `plan.json` alone, which predates all " +
      "prose. Under the corrected measure the v0.7.1 `lbw081` leak is real at 5.1% and every " +
      "other run is 0.0%, including the v0.7.3 rerun — so the guard removed the leak and the " +
      "score did not move, and the leak was not the cause of that task\'s low score.",
  },
  {
    version: "0.7.5",
    note:
      "batching, because the wall clock was never the model's fault. Measured on a four-scene " +
      "2,000-word run: **284 network round-trips**, **96% of them carrying exactly one tool " +
      "call**. The context-builder averaged 22.5 round-trips per turn and the index-manager " +
      "29.8, each one re-sending a transcript averaging 12,000 tokens (42,000 at its largest) " +
      "to receive about 200 tokens back — one file read, or one field written. That is 3.07M " +
      "billable tokens for 2,077 delivered words and 34 minutes of wall time, almost all of it " +
      "that loop. Several tool calls per reply have always been legal and are used " +
      "occasionally, so this is a prompt problem: `SHARED.md` now states the measurement and " +
      "asks every role to decide first and then act in a batch, the builder\'s brief gives " +
      "batched shell examples instead of one-per-line ones, and the index-manager is told that " +
      "partition *order* does not imply one request per partition, since no write depends on " +
      "the result of another.",
  },
  {
    version: "0.7.4",
    note:
      "the context-builder could invent packet material and cite nothing for it. `add_context_item` " +
      "takes a `source` and checked only that it was non-empty, so a fabricated provenance passed. " +
      "On the 20k run `lnb20k-fantasy-the-girl-with-a-thousand-faces` it added **93 items**, four of " +
      "which cite no file at all — two literally `source: \"synthetic\"` — and their contents are " +
      "invented world material handed to the writer as established: *\"Canonical behaviors when a " +
      "ritual \'goes wrong\'…\"*, *\"Practical use in scene: Mercy finds a faded portrait in a token " +
      "stall…\"*. The first calls itself canonical; the second stages the scene, which its own prompt " +
      "forbids in as many words. A source must now resolve to a file in the project, and the refusal " +
      "points at `note_gap` — which is the channel that already existed for this, and the difference " +
      "is where the invention gets recorded: a gap tells the writer it is free and what it invents " +
      "lands in the state delta as a decision, where a composed item is defended by every later " +
      "scene as though established. Also: a run killed *gracefully* released its lock, so the batch " +
      "classified it `fresh` — never attempted — and did not clear the directory; both 20k reruns " +
      "started on top of the abandoned attempt\'s index, HEAD, transcripts and four committed " +
      "scenes. It came out clean only because the second attempt went further and overwrote the " +
      "same paths. An existing `HEAD` with no summary now means incomplete.",
  },
  {
    version: "0.7.3",
    note:
      "the writer may no longer copy sentences out of its packet, and one of our own prompt " +
      "changes is why it did. `runs-070/lbw081` scored **78.6** against 81.5 for the version " +
      "before it, with Reading Experience at **2** — the lowest mark on any dimension in any " +
      "run we have. The manuscript interleaves object and character files with the narration, " +
      "in quotation marks, from the second paragraph on: *\"Victor's gold pocket watch found " +
      "stopped on his person; the minute hand bent and the watch stopped at a time relevant to " +
      "establishing the minute of death.\"* That last clause is registry language about why a " +
      "fact matters to an investigation and cannot occur in fiction. `smoke/probe-index-leak.py` " +
      "puts it at 5.7% of the manuscript over eight spans, against 0.0% for the two v0.7.1 runs " +
      "that scored 88.9 and 87.7 — so this is the whole of the regression and not the new craft " +
      "axis. The invitation was v0.7.0's own: the writer had just been told, of `canon_context`, " +
      "to *\"use the wording it gives you rather than a plausible equivalent\"*, meant to stop " +
      "it inventing variants of recorded facts and read as licence to quote the index. The " +
      "prompt now says facts, never sentences, and `write_staged_scene` refuses a draft sharing " +
      "a twelve-word run with its packet — the verifier had in fact caught it and filed it " +
      "correctly, as a craft warning, and a warning does not block, so it shipped.",
  },
  {
    version: "0.7.2",
    note:
      "a character walking somewhere stopped being a contradiction. The deterministic " +
      "continuity check compared every claimed value against canon and blocked on any " +
      "difference, so `char-eloise.location` going from `loc-eloise-house` to " +
      "`loc-main-street` — two children stepping off a stoop — was reported as " +
      "`geographical_contradictions` at severity `error`. Measured on `runs-070/lbw070` " +
      "s-002: twice in one scene, with the *same* finding id because both quoted the same " +
      "sentence, and the same two again on the rewrite, so the stall detector fired and the " +
      "scene committed carrying two recorded defects that were not defects. It also punished " +
      "the writer for following its own instructions, which give `location` as the model " +
      "standing property. Attributes that exist to change — location, what someone is " +
      "holding, what they know — now absorb silently and are counted in " +
      "`coverage.volatileChanges`; the dossier shows the verifier the move so it can still " +
      "ask whether the prose accounts for it, which is the real question and needs a reading. " +
      "Intrinsic properties still block. Also: craft *warnings* now reach the next scene's " +
      "writer, because a warning never opened a repair round and so was never shown to " +
      "anyone — three on `runs-070/lbw081` s-001 went into an audit file and stopped there, " +
      "which is an axis built to raise the quality score changing nothing.",
  },
  {
    version: "0.7.1",
    note:
      "the writer's follow-up allowance could be spent by the context-builder before the " +
      "writer asked anything, and on the opening tier that left it none. The allowance was " +
      "metered by counting `answer_writer` calls; that tool is on the builder's allowlist " +
      "permanently, so during its *initial* build — with no question outstanding — the builder " +
      "called it unprompted. Measured on `runs/v062/lbw081` s-001: the count reached one, the " +
      "opening allowance was one, and the writer's first and only question came back `no " +
      "follow-ups left`. It wrote the scene without the fact it had asked for and said so in " +
      "its closing message. Invisible in every summary, because the spontaneous call was " +
      "recorded *as* a follow-up — `follow_ups.by_tier` reported the mechanism as used. " +
      "`answer_writer` now requires an outstanding question, and the refusal message prints " +
      "the count and the allowance separately instead of printing the allowance for both.",
  },
  {
    version: "0.7.0",
    note:
      "the verifier gets a second axis and the evidence to use the first one. Three changes, " +
      "all of which move numbers. (1) A **craft axis**: findings for the defects the quality " +
      "rubrics penalise and ConStory's nineteen subtypes cannot express, each check naming the " +
      "graded dimension that penalises it — reported through a separate tool and counted in a " +
      "separate column, because pooling them would inflate EID with something that is not an " +
      "error in that taxonomy. Five checks may block, with checkable evidence required and a " +
      "cap of two per round; the rest warn. Motivated by the two worst defects found by " +
      "reading our own finished manuscripts, neither of which any layer could report: a story " +
      "that stopped instead of ending, and scenes that restate each other. (2) A " +
      "**deterministic dossier** in front of the verifier: every claim the draft makes against " +
      "what canon holds for it, with first establishments labelled as normal. The brief has " +
      "told the verifier to read the index since v0.1 and the measured result was three shell " +
      "reads across a nineteen-scene run — and eleven findings whose contradicting side was an " +
      "absence. It also finally passes the deterministic layer's findings, which the " +
      "verifier's own standing instructions have always told it to read. (3) `canon_context` " +
      "on a finding: the writer has no index access, so the verifier is the only participant " +
      "that can put a fact in front of it. Also: the opening tier's repair allowance goes 1 → " +
      "2, because the falsifiability check reported against the schedule — 5/5 opening scenes " +
      "hit their ceiling and committed carrying a defect, 0/10 endgame scenes reached theirs.",
  },
  {
    version: "0.6.2",
    note:
      "the verifier is stopped from reporting absences as contradictions. On the first run " +
      "with a same-family verifier it raised eleven findings shaped like " +
      "`objects/obj-note.yaml has no first_seen entry` and `the relation query returns " +
      "nothing for these two`, each labelled a contradiction pair with the empty result " +
      "standing in for the contradicting passage — and every one described a scene " +
      "establishing a fact for the first time, which is what a scene is for. That run scored " +
      "79.8 against 88.2 for a run with five real findings: the writer has no index access " +
      "and cannot tell a spurious finding from a real one, so it spent its repair rounds " +
      "writing provenance into prose that was already fine, and the prose is what is scored. " +
      "`makeFinding` now refuses an explicit-pair finding whose `contradicts.quote` is empty, " +
      "and the verifier brief states the direction outright. Also fixes a summary field that " +
      "lied: `verifier_model` was a hard-coded string naming the old default, so a run whose " +
      "roll-up plainly showed `verifier:gpt-5-mini` reported `gemini-3.1-pro-preview`",
  },
  {
    version: "0.6.1",
    note:
      "the verifier runs `gpt-5-mini`, the same backbone as every other role and as every " +
      "baseline. It was `gemini-3.1-pro-preview` from the start, on the argument that a " +
      "verifier from the writer's own family inherits its blind spots — a sound argument " +
      "that could not answer two objections. It broke the comparison: " +
      "docs/13-experiment-settings.md holds the generation backbone constant across " +
      "systems and every baseline runs gpt-5-mini throughout, so our +11.8 over the same " +
      "backbone on the LongBench-Write story slice mixed an architectural effect with a " +
      "stronger model in one role and could not be attributed. And it was unaffordable in " +
      "a way specific to us: the gateway returns zero cache reads for that model, so the " +
      "resident verifier re-sent its whole growing history every request (first-call input " +
      "10,142 → 61,934 tokens over four scenes at 8× the rate), reaching 81% of a run's " +
      "cost on 11% of its round-trips, and then exhausted the channel's plan quota so that " +
      "every call failed and scenes committed unverified. Cross-family is now the ablation " +
      "(`--verifier-model gemini-3.1-pro-preview`), recorded per run in `verifier_model`. " +
      "Every cost and quality row from before this is not comparable with one from after",
  },
  {
    version: "0.6.0",
    note:
      "the verifier starts each scene with an empty conversation instead of staying " +
      "resident for the whole run. Residency is paid for by re-sending the entire history " +
      "on every request, and whether that is affordable is a property of the provider: on " +
      "lbw081 the cross-family verifier (gemini-3.1-pro-preview) returned **zero** cache " +
      "reads on every call of every scene while the gpt-5-mini roles ran 60–84% cached, so " +
      "its first-call input grew 10,142 → 25,473 → 41,241 → 61,934 tokens across four " +
      "scenes and it became 81% of the run's cost ($17.42 of $21.62) on 11% of its " +
      "round-trips. At novel length that grows as scene count times history length, which " +
      "is the specific reason a 20,000-word target was unreachable. What the verifier gives " +
      "up is small and testable — its work is per-scene, cross-scene facts come from the " +
      "index it can read, and its durable lessons are in memory files that survive a reset " +
      "— and `--resident-all` restores the old behaviour as the ablation arm. Cost rows " +
      "from before and after are not comparable, so `fresh_each_scene` is recorded in every " +
      "summary",
  },
  {
    version: "0.5.1",
    note:
      "two repair-loop defects, both found by running 0.5.0 and both changing how much of " +
      "a manuscript survives. (1) A writer turn that failed outright — a provider content " +
      "filter, on the measured case — aborted the whole scene on the first failure with its " +
      "repair allowance unspent, and the orchestrator's sensible retry was then refused " +
      "because the transaction no longer existed; a failed turn now costs an attempt and " +
      "leaves the scene draftable, bounded by the scene's own allowance. (2) The livelock " +
      "detector compared finding *ids*, which are subtype plus quoted spans, so a writer " +
      "that rewrote the passage without fixing the defect produced a new id every round and " +
      "looked like progress: lbw081 s-001 spent three rounds on five findings that were all " +
      "the same causal-logic defect about one door. It now also stops when a blocking " +
      "subtype recurs after a rewrite without the blocking count falling. The second fix is " +
      "a precondition for 0.5.0's wider endgame ceiling — five repair rounds multiply the " +
      "cost of an undetected livelock by two and a half",
  },
  {
    version: "0.5.0",
    note:
      "per-scene compute is allocated by position in the story instead of by three " +
      "constants: repair rounds and writer follow-ups go 1 / 3 / 5 across the opening " +
      "third, the middle third and the final 40%, and the packet carries 1 / 2 / 3 " +
      "previous scenes of prose. The opening tier is deliberately *tighter* than the " +
      "0.4.0 default of two repair rounds — rounds not spent where defects are rare are " +
      "what pay for the tier where they accumulate — so an opening scene in 0.5.0 has " +
      "less room than the same scene had in 0.4.0 and a late scene has more. The " +
      "empirical basis is experiments/degradation (consistency-error instances rise with " +
      "finished length, r=0.711 over 16 cells, all four per-premise correlations " +
      "positive; timeline/plot and factual detail are 54.8% of them). Note the inference " +
      "being made: that experiment varies total length across runs, not position within " +
      "one run, so every scene's allowance is now recorded beside its findings to make " +
      "the schedule falsifiable from run data. `--max-repairs <n>` no longer sets a " +
      "global ceiling; it pins every scene to the same allowance and is the " +
      "uniform-allocation ablation arm. Verifier findings must now carry an actionable " +
      "`suggestion`, and a scene that cannot be repaired commits with its findings " +
      "recorded rather than being dropped (that change landed at the end of 0.4.0 and " +
      "moves the length score materially, so runs straddling it are not comparable)",
  },
  {
    version: "0.4.0",
    note:
      "the orchestrator drives each scene through call_context_builder / call_writer / " +
      "call_verifier / call_index_manager instead of the engine calling them in a fixed " +
      "order; artefacts are written to paths rather than passed inline; the write gate is " +
      "enforced by a read-only mount and demonstrated at startup; the token budget charges " +
      "input+output only (it previously charged cache reads, which were 89.5% of a run and " +
      "stopped it after a ninth of the allowed work); level-1 compaction triggers on " +
      "evictable payload bulk rather than only on overflow; a failed provider call is " +
      "retried and, if it cannot get through, the scene is recorded unverified rather than " +
      "silently approved; the writer is told the per-scene word target, which it previously " +
      "received as zero",
  },
];
