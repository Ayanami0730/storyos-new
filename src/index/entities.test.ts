import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type BeliefEntry,
  type CharacterProfile,
  type StateEntry,
  attributeAdvice,
  attributeKind,
  beliefsAsOf,
  currentState,
  identityFacts,
  parseJsonl,
  renderCharacter,
  serialiseJsonl,
} from "./entities.ts";

const profile: CharacterProfile = {
  id: "char-araine",
  name: "Araine",
  sketch: "A meticulous harbour cartographer.",
  identity: { profession: "harbour cartographer", appearance: "grey eyes, ink-stained cuffs" },
  provenance: { profession: "s-001", appearance: "s-001" },
};

const moved: readonly StateEntry[] = [
  { scene: "s-001", attribute: "location", value: "loc-docks", quote: "She stood on the docks." },
  {
    scene: "s-002",
    attribute: "location",
    value: "loc-charthouse",
    quote: "Light came in a thin rectangle through the high window.",
  },
  {
    scene: "s-010",
    attribute: "location",
    value: "loc-old-market",
    quote: "She left the warden's office and crossed the quay to the old market.",
  },
];

describe("which kind of attribute this is", () => {
  it("separates what varies from what does not", () => {
    assert.equal(attributeKind("location"), "state");
    assert.equal(attributeKind("mood"), "state");
    assert.equal(attributeKind("appearance"), "identity");
    assert.equal(attributeKind("profession"), "identity");
  });

  it("normalises spelling so the same concept lands in the same slot", () => {
    // Free-form naming is exactly how the first long run went wrong: a name
    // that has never been used cannot collide, so the writer invented one per
    // scene and nothing was ever superseded.
    assert.equal(attributeKind("Location"), "state");
    assert.equal(attributeKind(" holds "), "state");
  });

  it("rejects the event-shaped names the writer actually produced", () => {
    for (const name of [
      "left_market_and_crossed_to_docks",
      "visited_warden_office_then_entered_catacombs",
      "made_rubbing_of_washers_instead_of_photographing",
      "action",
    ]) {
      assert.equal(attributeKind(name), "unknown", name);
    }
  });

  it("tells the agent where the thing it wanted to record actually goes", () => {
    const advice = attributeAdvice("left_market_and_crossed_to_docks");
    assert.match(advice, /timeline event/);
    assert.match(advice, /location/);
  });
});

describe("current state from a timeline", () => {
  it("is the newest entry, so moving rooms is not a contradiction", () => {
    // The defect this replaces: four of five blocking findings in runs/v4-24k
    // were "location was established as loc-docks and this scene asserts X
    // without declaring the change deliberate".
    assert.equal(currentState(moved).location!.value, "loc-old-market");
    assert.equal(currentState(moved).location!.scene, "s-010");
  });

  it("orders by scene rather than by position in the file", () => {
    const shuffled = [moved[2]!, moved[0]!, moved[1]!];
    assert.equal(currentState(shuffled).location!.value, "loc-old-market");
  });

  it("keeps attributes independent", () => {
    const mixed: StateEntry[] = [
      ...moved,
      { scene: "s-002", attribute: "holds", value: "master chart", quote: "chart under her arm" },
    ];
    const now = currentState(mixed);
    assert.equal(now.location!.value, "loc-old-market");
    assert.equal(now.holds!.value, "master chart");
  });
});

describe("belief, tracked apart from truth", () => {
  const beliefs: BeliefEntry[] = [
    {
      scene: "s-001",
      proposition: "the city rearranges at night",
      stance: "ignorant-of",
      quote: "She assumed a measurement error.",
    },
    {
      scene: "s-006",
      proposition: "the city rearranges at night",
      stance: "knows",
      quote: "She felt the paving shift under her.",
    },
  ];

  it("answers as of a scene, so a packet cannot leak what is not known yet", () => {
    assert.equal(beliefsAsOf(beliefs, "s-003")[0]!.stance, "ignorant-of");
    assert.equal(beliefsAsOf(beliefs, "s-008")[0]!.stance, "knows");
  });

  it("collapses a proposition to its latest stance rather than listing both", () => {
    assert.equal(beliefsAsOf(beliefs, "s-010").length, 1);
  });
});

describe("what the deterministic layer is given", () => {
  it("sees identity only, because state changing is not a defect", () => {
    const facts = identityFacts([profile]);
    assert.deepEqual(
      facts.map((f) => f.attribute).sort(),
      ["appearance", "profession"],
    );
    assert.equal(facts[0]!.source, "s-001", "provenance travels with the fact");
  });
});

describe("how a character reads in a packet", () => {
  it("labels identity as retcon-only and state as of now", () => {
    const rendered = renderCharacter({
      profile,
      state: moved,
      beliefs: [
        {
          scene: "s-001",
          proposition: "the city rearranges at night",
          stance: "ignorant-of",
          quote: "q",
        },
      ],
      asOfScene: "s-003",
    });
    assert.match(rendered, /identity \(changing any of these is a retcon\)/);
    assert.match(rendered, /location: loc-charthouse {2}\(s-002\)/);
    assert.match(rendered, /ignorant-of: the city rearranges at night/);
    assert.doesNotMatch(rendered, /loc-old-market/, "s-010 has not happened yet at s-003");
  });
});

describe("jsonl round trip", () => {
  it("survives it exactly, and an empty log is an empty string not a blank line", () => {
    assert.equal(serialiseJsonl([]), "");
    assert.deepEqual(parseJsonl<StateEntry>(serialiseJsonl(moved)), moved);
  });
});
