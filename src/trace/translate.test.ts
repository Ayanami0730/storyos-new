import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { properNouns, chunkForTranslation } from "./translate.ts";
import type { TraceBundle } from "./types.ts";

function bundle(entityIds: readonly string[], sketches: readonly string[] = []): TraceBundle {
  return {
    plan: {
      logline: { en: "Wry, patient, obsessed. Stopped watches everywhere." },
      worldRules: [],
      entities: entityIds.map((id, i) => ({
        id,
        sketch: { en: sketches[i] ?? "" },
      })),
    },
  } as unknown as TraceBundle;
}

describe("the pinned name glossary", () => {
  it("finds a character named only in the entity id", () => {
    // The defect this pins: `char-inspector-hale`'s sketch reads "Metropolitan
    // police inspector in charge of the case" and never says Hale. The first
    // version scraped sketches, missed him, and he came back 黑尔 sixty-three
    // times and 海尔 ten in the same bundle.
    const nouns = properNouns(
      bundle(
        ["char-inspector-hale"],
        ["Metropolitan police inspector in charge of the case."],
      ),
    );
    assert.ok(nouns.includes("Hale"), "the bare surname is the form prose uses");
    assert.ok(nouns.includes("Inspector Hale"), "and the full form a scene card uses");
  });

  it("does not pin a role word as though it were a name", () => {
    const nouns = properNouns(bundle(["char-inspector-hale", "char-sir-arthur-lydon"]));
    assert.ok(!nouns.includes("Inspector"));
    assert.ok(!nouns.includes("Sir"));
    assert.ok(nouns.includes("Arthur"));
    assert.ok(nouns.includes("Lydon"));
  });

  it("ignores ordinary words that merely began a sentence", () => {
    // `Wry → 扭曲` and `Stopped → 停滞` were both in a real glossary, pinned
    // from sketch text. Working from ids means prose cannot contribute at all.
    const nouns = properNouns(bundle(["char-jonah-vale"], ["Wry, observant. Stopped clocks."]));
    assert.deepEqual(nouns.sort(), ["Jonah", "Jonah Vale", "Vale"]);
  });

  it("leaves out locations and objects, which are not names to fix", () => {
    const nouns = properNouns(
      bundle(["char-jonah-vale", "loc-lydon-house-study", "object-pocket-watch"]),
    );
    assert.ok(!nouns.some((n) => /Pocket|Watch|Study/.test(n)));
  });
});

describe("chunking long fields", () => {
  it("leaves a short field alone", () => {
    assert.deepEqual(chunkForTranslation("one paragraph"), ["one paragraph"]);
  });

  /**
   * The bound is measured, not chosen: on a deep ingest of `lbw081` blocks over
   * 8,000 characters failed 8 times in 33 by echoing their input instead of
   * translating it, while the 3,000–8,000 band failed once in 47.
   */
  it("splits on paragraph boundaries and loses nothing", () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"x".repeat(200)}`);
    const text = paragraphs.join("\n\n");
    const chunks = chunkForTranslation(text, 1_000);

    assert.ok(chunks.length > 1, "a 8k-character field must be split");
    assert.equal(chunks.join(""), text, "rejoining must reproduce the source exactly");
    // Every chunk starts at a paragraph, so each one is translatable on its own.
    for (const chunk of chunks) assert.match(chunk, /^Paragraph \d+/);
  });

  it("falls back to line boundaries for a single oversized paragraph", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"y".repeat(100)}`).join("\n");
    const chunks = chunkForTranslation(text, 500);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), text);
  });

  it("never exceeds the limit except where a single line does", () => {
    const text = `${"a".repeat(300)}\n\n${"b".repeat(300)}\n\n${"c".repeat(300)}`;
    for (const chunk of chunkForTranslation(text, 400)) {
      assert.ok(chunk.length <= 400 || !chunk.includes("\n"), `chunk of ${chunk.length}`);
    }
  });
});
