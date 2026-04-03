import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenClawIndex, searchOpenClawIndex } from "../scripts/openclaw-paper-search-lib.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(testDir, "fixtures", "paper-index-fixture.json");

async function loadFixtureIndex() {
  const rawFixture = await readFile(fixturePath, "utf8");
  return JSON.parse(rawFixture);
}

async function runTest(name, fn) {
  await fn();
  console.log(`ok - ${name}`);
}

await runTest("buildOpenClawIndex creates normalized records sorted latest-first", async () => {
  const sourceIndex = await loadFixtureIndex();
  const index = buildOpenClawIndex(sourceIndex);

  assert.equal(index.metadata.paper_count, 4);
  assert.equal(index.papers[0].question_paper_code, "215536");
  assert.equal(index.papers[1].question_paper_code, "214468");
  assert.equal(index.papers[0].normalized_course_name, "3D Design to Digital Fabrication: CAD, CAM and AM Essentials (102907/ME531M)");
  assert.deepEqual(index.papers[0].codes, ["102907", "215536"]);
});

await runTest("searchOpenClawIndex prioritizes exact question paper codes", async () => {
  const sourceIndex = await loadFixtureIndex();
  const index = buildOpenClawIndex(sourceIndex);
  const result = searchOpenClawIndex(index, "215536");

  assert.equal(result.status, "ok");
  assert.equal(result.total, 1);
  assert.equal(result.results[0].question_paper_code, "215536");
});

await runTest("searchOpenClawIndex resolves natural language with structured hints", async () => {
  const sourceIndex = await loadFixtureIndex();
  const index = buildOpenClawIndex(sourceIndex);
  const result = searchOpenClawIndex(index, "data structures supplementary june 2024 s3");

  assert.equal(result.status, "ok");
  assert.equal(result.total, 1);
  assert.equal(result.results[0].question_paper_code, "212319");
});

await runTest("searchOpenClawIndex requires strong coverage for multi-token course names", async () => {
  const sourceIndex = await loadFixtureIndex();
  const index = buildOpenClawIndex(sourceIndex);
  const result = searchOpenClawIndex(index, "control structures");

  assert.equal(result.status, "none");
  assert.equal(result.total, 0);
});

await runTest("searchOpenClawIndex matches free-text course names", async () => {
  const sourceIndex = await loadFixtureIndex();
  const index = buildOpenClawIndex(sourceIndex);
  const result = searchOpenClawIndex(index, "digital control systems");

  assert.equal(result.status, "ok");
  assert.equal(result.total, 1);
  assert.equal(result.results[0].course_name, "Digital Control Systems (102001/EE301)");
});

await runTest("searchOpenClawIndex returns none when nothing matches", async () => {
  const sourceIndex = await loadFixtureIndex();
  const index = buildOpenClawIndex(sourceIndex);
  const result = searchOpenClawIndex(index, "quantum field theory");

  assert.equal(result.status, "none");
  assert.equal(result.total, 0);
  assert.deepEqual(result.results, []);
});
