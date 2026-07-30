import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { requestedParts, sceneCountForRequest } from "./parts.ts";

/**
 * The prompts here are verbatim fragments of LongBench-Write tasks, so a passing
 * test means the count is read off the requests we are actually scored on.
 */
describe("a part count the request states outright", () => {
  it("reads 五篇 off the diary task the judge marked us down on", () => {
    const parts = requestedParts('创作五篇关于"独自旅行去日本"的日记。');
    assert.equal(parts?.count, 5);
    assert.match(parts!.quote, /五篇/);
  });

  it("reads 分两部分写 off the task we score worst on", () => {
    assert.equal(requestedParts("分两部分写，各写1000字")?.count, 2);
  });

  it("reads 共五幕 and not 五个人 from the same sentence", () => {
    // Both appear in lbw112. A cast size is not a structure, and taking it as one
    // would force five scenes for the wrong reason on a task that happens to agree.
    const parts = requestedParts("请写一份有五个人搞笑的青春校园剧本，明确各角色所说话语，共五幕");
    assert.equal(parts?.count, 5);
    assert.match(parts!.quote, /五幕/);
    assert.equal(requestedParts("一个有五个人的房间"), null);
  });

  it("says nothing when the request names no structure", () => {
    assert.equal(requestedParts("请帮助写出一个有趣的故事，2000字左右。"), null);
    assert.equal(requestedParts("Write a first-person detective story."), null);
  });

  it("reads an English count", () => {
    assert.equal(requestedParts("Write five chapters about the voyage.")?.count, 5);
    assert.equal(requestedParts("in 3 parts")?.count, 3);
  });

  it("ignores a count that is not a division of the work", () => {
    // Days, words and pages are all measured in the LongBench-Write prompts and
    // none of them is a scene.
    assert.equal(requestedParts("a five day trip"), null);
    assert.equal(requestedParts("each about 1000 words"), null);
    assert.equal(requestedParts("Write a 50-page novel"), null);
  });

  it("stays inside a plausible range", () => {
    assert.equal(requestedParts("一篇日记"), null, "one part is not a structure");
    assert.equal(requestedParts("write 40 chapters"), null, "past any real ask");
  });
});

describe("choosing the scene count", () => {
  it("lets the stated structure outrank the length-derived count", () => {
    const { count, parts } = sceneCountForRequest(4, 2000, "创作五篇日记", 500);
    assert.equal(count, 5);
    assert.equal(parts?.count, 5);
  });

  it("honours a 400-word part, which is what the diary task asks for", () => {
    // The general 500-word floor is about a count we derived. 2,000 words in 五篇
    // is 400 a part, and refusing it is what produced four entries out of five.
    assert.equal(sceneCountForRequest(4, 2000, "创作五篇日记", 500).count, 5);
  });

  it("keeps the derived count when the parts really would be fragments", () => {
    const { count, parts } = sceneCountForRequest(2, 1000, "分五部分写", 500);
    assert.equal(count, 2);
    assert.equal(parts?.count, 5, "still reported, so the planner can be told");
  });

  it("passes the derived count through when nothing is stated", () => {
    assert.equal(sceneCountForRequest(8, 10_000, "Write a novel.", 500).count, 8);
  });
});
