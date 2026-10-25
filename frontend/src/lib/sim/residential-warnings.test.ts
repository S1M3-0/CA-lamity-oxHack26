import assert from "node:assert/strict";
import test from "node:test";
import { buildResidentialWarnings, residentialAlertsAtFrame } from "./residential-warnings";
import type { Terrain, SimResult } from "./types";

function fixture() {
  const t = { w: 20, h: 20, cellM: 100, residential: new Uint8Array(400) } as Terrain;
  const result: SimResult = {
    frames: Array.from({ length: 10 }, () => new Uint8Array(400)),
    arrival: new Float32Array(400).fill(Infinity), area: Array(10).fill(0),
  };
  return { t, result };
}

test("warns only where residential cells intersect the simulated storm footprint", () => {
  const { t, result } = fixture();
  t.residential![21] = 1;
  t.residential![22] = 1; // same kilometre area, should not duplicate the warning
  t.residential![390] = 1; // outside the path
  result.frames[2][21] = 200;
  result.frames[3][22] = 200;
  result.frames[2][50] = 255; // storm over nonresidential ground
  result.frames[4][390] = 55; // traces below warning intensity
  const warnings = buildResidentialWarnings(t, result);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].cell, 21);
  assert.equal(warnings[0].firstFrame, 2);
  assert.deepEqual(residentialAlertsAtFrame(warnings, 0), [
    { id: warnings[0].id, cell: 21, status: "upcoming", hoursUntil: 0.5 },
  ]);
  assert.equal(residentialAlertsAtFrame(warnings, 2)[0].status, "active");
  assert.deepEqual(residentialAlertsAtFrame(warnings, 4), []);
  assert.equal(residentialAlertsAtFrame(warnings, 0)[0].status, "upcoming", "rewinding restores warnings");
});

test("handles dissipation gaps, reformation, and distinct residential areas", () => {
  const { t, result } = fixture();
  t.residential![21] = t.residential![390] = 1;
  result.frames[1][21] = result.frames[6][21] = result.frames[8][390] = 200;
  const warnings = buildResidentialWarnings(t, result);
  assert.equal(warnings.length, 2);
  const alerts = residentialAlertsAtFrame(warnings, 3);
  assert.equal(alerts[0].status, "upcoming");
  assert.equal(alerts[0].hoursUntil, 0.75);
  assert.deepEqual(residentialAlertsAtFrame(warnings, 9), []);
});

test("does not invent residential warnings when map data is absent or empty", () => {
  const { t, result } = fixture();
  result.frames[0].fill(255);
  assert.deepEqual(buildResidentialWarnings(t, result), []);
  delete t.residential;
  assert.deepEqual(buildResidentialWarnings(t, result), []);
});
