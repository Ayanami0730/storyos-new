import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { VERSION, VERSION_HISTORY, VERSION_NOTE } from "./version.ts";

const packageVersion = (
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { version: string }
).version;

describe("the version stamp", () => {
  /**
   * The failure this exists for, which is embarrassing and was invisible for seven
   * releases.
   *
   * `VERSION` is stamped into every `summary.json` and every trace bundle, and the
   * file's own header says why: "a result whose version is unknown cannot be
   * compared with anything". It was bumped by scripted string replacement — find the
   * previous literal, write the next one — and at v0.7.6 only `package.json` was
   * bumped. Every later replacement then searched `version.ts` for a literal that
   * was no longer there, found nothing, and **silently did nothing**. The constant
   * sat at `0.7.5` through 0.7.6, 0.7.7, 0.8.0, 0.8.1 and 0.8.2 while
   * `VERSION_HISTORY` gained correct entries for all of them, because those anchored
   * on the array instead.
   *
   * The cost was runs that could not be attributed: a batch launched deliberately to
   * measure v0.8.1 wrote `harness_version: "0.7.5"` into its summary, and the only
   * way to recover which code produced it is to compare the run's start time against
   * the git log.
   *
   * A test is the right shape for this because the two numbers have to agree and
   * nothing else was checking. A silent no-op cannot survive an assertion.
   */
  it("agrees with package.json", () => {
    assert.equal(
      VERSION,
      packageVersion,
      `src/version.ts says ${VERSION} and package.json says ${packageVersion}. ` +
        `Every run is stamped with the first of those, so they must not disagree.`,
    );
  });

  it("has a history entry for the current version", () => {
    // The other half of the same failure: a bump with no entry produces an artefact
    // whose version is known and whose meaning is not.
    assert.ok(
      VERSION_HISTORY.some((e) => e.version === VERSION),
      `no VERSION_HISTORY entry for ${VERSION}`,
    );
  });

  it("keeps the history newest-first and free of duplicates", () => {
    const versions = VERSION_HISTORY.map((e) => e.version);
    assert.equal(new Set(versions).size, versions.length, "duplicate version entries");
    assert.equal(versions[0], VERSION, "the newest entry should be the current version");
  });

  it("carries a note a reader of a six-month-old summary could use", () => {
    assert.ok(VERSION_NOTE.length > 100);
  });
});
