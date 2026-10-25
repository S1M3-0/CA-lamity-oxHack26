import assert from "node:assert/strict";
import test from "node:test";
import { simulateHurricane } from "./hurricane";
import { FRAME_COUNT, FRAMES_PER_HOUR, type Params, type Terrain } from "./types";

function terrain(size = 100): Terrain {
  return {
    key: "test", name: "Test", center: [0, 40], w: size, h: size, cellM: 120,
    bounds: { west: -1, east: 1, south: 39, north: 41 },
    elev: new Float32Array(size * size), fuel: new Float32Array(size * size),
    water: new Uint8Array(size * size), runoff: new Float32Array(size * size),
    sea: new Uint8Array(size * size), demSource: "synthetic", fuelSource: "uniform",
    minElev: 0, maxElev: 0,
  };
}
const params: Params = { windDir: 270, windSpeed: 20, humidity: 30, rainfall: 50, stormHours: 24, saturation: 40 };

function centroid(frame: Uint8Array, w: number) {
  let x = 0, y = 0, count = 0;
  frame.forEach((v, k) => {
    if (!v) return;
    x += k % w;
    y += Math.floor(k / w);
    count++;
  });
  assert.ok(count > 0, "storm should still be on the map");
  return { x: x / count, y: y / count };
}

test("starts at the clicked cell, grows around a calm eye, then dissipates", () => {
  const t = terrain();
  const origin = 50 * t.w + 30;
  const result = simulateHurricane(t, { ...params, windSpeed: 0 }, origin, 42);
  assert.equal(result.frames.length, FRAME_COUNT);
  assert.deepEqual(centroid(result.frames[0], t.w), { x: 30, y: 50 });
  for (const i of [24, 48]) {
    assert.ok(result.area[i] > result.area[i - 24], "storm footprint grows over each six-hour interval");
    assert.equal(result.frames[i][origin], 0, "eye remains clear");
    assert.deepEqual(result.stormTrack![i], { col: 30, row: 50 }, "eye stays fixed in calm winds even as bands break up");
  }
  assert.ok(result.area[72] < result.area[48], "storm weakens after maturity");
  assert.equal(result.area[96], 0, "storm dissipates by the end of the run");
  assert.ok(result.frames[96].every((v) => v === 0));
});

for (const windDir of [0, 45, 90, 180, 270, 355]) {
  test(`travels downwind within the 15 degree cone for wind from ${windDir} degrees`, () => {
    const t = terrain();
    const origin = 50 * t.w + 50;
    const result = simulateHurricane(t, { ...params, windDir }, origin, 123);
    const expected = (windDir + 180) * Math.PI / 180;
    let previous = result.stormTrack![0];
    // Test the eye's actual movement: a patchy footprint's centroid can jump as cells die.
    for (let i = 1; i < FRAME_COUNT; i++) {
      const current = result.stormTrack![i];
      const dx = current.col - previous.col, north = previous.row - current.row;
      const forward = dx * Math.sin(expected) + north * Math.cos(expected);
      const sideways = dx * Math.cos(expected) - north * Math.sin(expected);
      assert.ok(forward > 0);
      assert.ok(Math.abs(Math.atan2(sideways, forward)) <= Math.PI / 12);
      const x = Math.round(current.col), y = Math.round(current.row);
      if (x >= 0 && x < t.w && y >= 0 && y < t.h) {
        assert.equal(result.frames[i][y * t.w + x], 0, "tracked eye is clear in the rendered frame");
      }
      previous = current;
    }
  });
}

test("storm cells form and die before whole-storm dissipation begins", () => {
  const t = terrain();
  const result = simulateHurricane(t, { ...params, windSpeed: 0 }, 50 * t.w + 50, 42);
  let births = 0, deaths = 0;
  for (let i = 8; i < 48; i++) {
    result.frames[i].forEach((v, k) => {
      if (v && !result.frames[i - 1][k]) births++;
      if (!v && result.frames[i - 1][k]) deaths++;
    });
  }
  assert.ok(births > 100, "new patches form");
  assert.ok(deaths > 100, "old patches break apart during growth");
});

test("seeded runs repeat and report matching area and first-arrival times", () => {
  const t = terrain(64);
  const origin = 32 * t.w + 20;
  const first = simulateHurricane(t, params, origin, 91);
  assert.deepEqual(first, simulateHurricane(t, params, origin, 91));
  assert.notDeepEqual(first.frames, simulateHurricane(t, params, origin, 92).frames);
  const expectedArrival = new Float32Array(t.w * t.h).fill(Infinity);
  first.frames.forEach((frame, i) => {
    let count = 0;
    assert.equal(frame.length, t.w * t.h);
    frame.forEach((v, k) => {
      if (!v) return;
      count++;
      assert.ok(v >= 40 && v <= 255);
      if (expectedArrival[k] === Infinity) expectedArrival[k] = i / FRAMES_PER_HOUR;
    });
    assert.equal(first.area[i], count * t.cellM * t.cellM / 1e6);
  });
  assert.deepEqual(first.arrival, expectedArrival);
});

test("a storm can leave the grid without wrapping around or restarting", () => {
  const t = terrain(64);
  const result = simulateHurricane(t, { ...params, windDir: 90, windSpeed: 100 }, 32 * t.w + 1, 11);
  assert.ok(result.area[0] > 0);
  assert.equal(result.area.at(-1), 0);
  for (const frame of result.frames) {
    for (let y = 0; y < t.h; y++) assert.equal(frame[y * t.w + t.w - 1], 0);
  }
});
