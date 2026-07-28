import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { declaredPersonKind, findPersonDrift } from "./person.ts";

const THIRD = { person: "third person limited, Rue", tense: "past" };

describe("narrative person, checked against what the plan declared", () => {
  /**
   * The seven sentences LiveNovelBench charged us for, verbatim. They were 78%
   * of our consistency error count on the metric, they all came from scenes 1–3
   * of 17, and the model verifier — holding the drafts they are in — reported
   * zero contradictions across the whole run.
   */
  const MEASURED = [
    "The list was already up when we came in: a narrow column of names pinned beneath the Folio's page, the rest of the book gone for the afternoon as if it were too heavy for public eyes.",
    "The ring cut across our chatter and, as always, words from the Hall followed—ceremony turned to schedule—and we moved like a practiced thing toward the long table.",
    "The board under the entry light showed our names in their neat column and gave Rue a particular, domestic kind of relief.",
    "The Folio's presence was public enough for us to see it; the Archive would take the book later, the woman who posted the list had said, but we had the list.",
    "Loren's classroom sat where the workshops did: an honest room of a repaired floor and benches that had belonged to other hands before ours.",
    "When they led us there the door was a slab below the library's stacks, heavy and unadorned.",
    "Stories about the Three were told to us as if they were both threat and promise.",
  ];

  it("finds every drift the benchmark charged us for", () => {
    for (const sentence of MEASURED) {
      const hits = findPersonDrift(sentence, THIRD);
      assert.equal(hits.length, 1, `missed: ${sentence.slice(0, 60)}…`);
      assert.match(hits[0]!.why, /first-person plural/);
    }
  });

  /**
   * The reason a naive version of this is unusable. Characters say "we", and
   * counting dialogue took the rate to 43.78 hits per 10k words against a ground
   * truth of 3.83 — a detector that fires on every page of speech would spend a
   * repair round per scene on nothing.
   */
  it("does not read dialogue as narration", () => {
    assert.deepEqual(
      findPersonDrift('"We keep the record here in the Ink Room; we do not adjudicate," she said.', THIRD),
      [],
    );
    assert.deepEqual(
      findPersonDrift("\u201cWe count craft, we count hours,\u201d the Headmistress said.", THIRD),
      [],
    );
  });

  it("leaves ordinary third-person narration alone", () => {
    assert.deepEqual(
      findPersonDrift(
        "Rue walked toward the ferry with the packet safe against her ribs. The Bell rang once.",
        THIRD,
      ),
      [],
    );
  });

  /**
   * Only the decidable direction. A first-person narrator says "we" about a group
   * they are in and describes other people in the third person constantly, so
   * neither is evidence of anything and claiming otherwise would fire on every
   * first-person book.
   */
  it("claims nothing about a first-person narration", () => {
    const first = { person: "first person, Rue", tense: "past" };
    assert.deepEqual(findPersonDrift("We came in and the list was already up.", first), []);
    assert.deepEqual(findPersonDrift("Rue walked toward the ferry.", first), []);
  });

  it("reads the declared person out of the plan's own wording", () => {
    assert.equal(declaredPersonKind("first person, Rue"), "first");
    assert.equal(declaredPersonKind("first person plural, the Hundred"), "first");
    assert.equal(declaredPersonKind("third person limited, Rue"), "third");
    assert.equal(declaredPersonKind("third person omniscient"), "third");
    assert.equal(
      declaredPersonKind("third person limited, one viewpoint per scene, alternating"),
      "third",
    );
  });

  it("reports each drifting sentence so a repair brief can show the pattern", () => {
    const prose = MEASURED.join(" ");
    assert.equal(findPersonDrift(prose, THIRD).length, MEASURED.length);
  });
});
