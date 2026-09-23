import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../Three-Body Problem.html', import.meta.url), 'utf8');
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const speeds = JSON.parse(html.match(/const SPEEDS = (\[[^;]+\]);/)[1]);
const rates = [...html.matchAll(/\{ id: '[^']+', name: '[^']+',[^\n]*?rate: ([\d.]+)/g)].map(m => Number(m[1]));
const clockCode = between('function resetVisuals()', 'function colorOf(')
  + between('function frame(now)', '/* ------------------------------------------------------------------ start */')
  + html.match(/function setSpeed\(i\) \{[^\n]+/)[0];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

// Exercise the application's real frame/tick/visual-clock code. Physics completion is controlled
// here so a slow CPU and a stalled simulation can be checked deterministically.
function harness(rate = 6) {
  const noop = () => {};
  const c = {
    visuals: { time: 0, spinTime: 0, climates: new Map() },
    world: { playing: true, t: 0, preset: { rate }, cur: [], sys: {} },
    document: { hidden: false }, reducedMotion: false,
    ui: { speed: speeds.indexOf(1) }, SPEEDS: speeds,
    perf: { ema: 1 / 60, bad: 0, quality: 0 }, drama: { cur: 1 },
    renderMs: 0, watchAt: Infinity, bodiesDirty: false,
    last: 0, layoutDirty: false, dirtyUntil: Infinity, drag: {},
    completion: 1, advanceCalls: 0, effectUpdates: [], effectResets: 0,
    performance: { now: () => 0 },
    clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)),
    sampleBodies: () => [], accountThrottle: noop, throttle: {},
    watch: noop, refreshBodies: noop, updateCamera: noop, render: noop,
    updateScaleBar: noop, updateReadouts: noop, requestAnimationFrame: noop, measure: noop,
    store: { set: noop }, refreshSpeed: noop,
  };
  c.advance = target => { c.advanceCalls++; return c.world.t + (target - c.world.t) * c.completion; };
  c.dramaTarget = () => c.drama.cur;
  c.eventEffects = {
    update: (dt, options) => c.effectUpdates.push({ dt, ...options }),
    reset: () => c.effectResets++,
  };
  vm.createContext(c);
  vm.runInContext(clockCode, c);
  return c;
}

test('rotation tracks every playback speed proportionally across preset simulation rates', () => {
  assert.equal(rates.length, 9, 'cover every current preset');
  for (const rate of rates) for (let i = 0; i < speeds.length; i++) {
    const c = harness(rate);
    c.setSpeed(i);
    c.tick(50, .05);
    near(c.world.t, .05 * speeds[i] * rate);
    near(c.visuals.spinTime, .05 * speeds[i]);
    near(c.visuals.time, .05);
  }
});

test('changing speed preserves rotational phase and affects only subsequent advancement', () => {
  const c = harness();
  c.tick(50, .05);
  c.setSpeed(speeds.indexOf(8));
  near(c.visuals.spinTime, .05);
  c.tick(100, .05);
  near(c.visuals.spinTime, .45);
  c.setSpeed(speeds.indexOf(.25));
  near(c.visuals.spinTime, .45);
  c.tick(150, .05);
  near(c.visuals.spinTime, .4625);
});

test('rotation follows close-pass slowdown and actual budget-limited progress, including a stall', () => {
  const c = harness();
  c.drama.cur = .25;
  c.completion = .4;
  c.tick(50, .05);
  near(c.visuals.spinTime, .05 * .25 * .4);
  c.completion = 0;
  c.tick(100, .05);
  near(c.visuals.spinTime, .005);
  near(c.visuals.time, .1, 'event presentation remains on its own real-seconds clock');
  assert.equal(c.effectUpdates.length, 2);
});

test('pause and reduced motion freeze rotation without accumulating time to catch up later', () => {
  const c = harness();
  c.tick(50, .05);
  c.world.playing = false;
  c.tick(100, .05);
  near(c.visuals.spinTime, .05);
  assert.equal(c.advanceCalls, 1);
  assert.equal(c.effectUpdates.at(-1).playing, false);
  c.world.playing = true;
  c.reducedMotion = true;
  c.tick(150, .05);
  near(c.visuals.spinTime, .05);
  near(c.visuals.time, .05);
  c.reducedMotion = false;
  c.tick(200, .05);
  near(c.visuals.spinTime, .1);
});

test('hidden frames skip simulation and rotation and discard their elapsed wall time', () => {
  const c = harness();
  c.document.hidden = true;
  c.frame(30000);
  assert.equal(c.advanceCalls, 0);
  near(c.visuals.spinTime, 0);
  c.document.hidden = false;
  c.frame(30020);
  near(c.visuals.spinTime, .02);
  near(c.world.t, .02 * c.world.preset.rate);
});

test('reset clears rotational phase together with climates and transient effects', () => {
  const c = harness();
  c.tick(50, .05);
  c.visuals.climates.set(3, 2);
  c.resetVisuals();
  near(c.visuals.spinTime, 0);
  near(c.visuals.time, 0);
  assert.equal(c.visuals.climates.size, 0);
  assert.equal(c.effectResets, 1);
});
