import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/event-effects.js', import.meta.url), 'utf8');
const star = { id: 0, m: 1, x: 80, y: 0, vx: 0, vy: 0 };
const planet = { id: 1, m: 0.001, kind: 'planet', x: 0, y: 0, vx: 0, vy: 0 };
const moon = { id: 2, m: 0.0001, kind: 'moon', x: 18, y: 0, vx: 0, vy: 0 };
const rip = { type: 'rip', t: 1, id: 1, by: 0 };
const defaults = {
  bodies: [star, planet, moon],
  project: b => ({ x: b.x + 100, y: b.y + 100 }),
  radius: b => b.kind === 'moon' ? 4.5 : b.kind === 'planet' ? 7 : 13,
  quality: 0,
  theme: 'dark'
};

function loadEngine(globals = {}) {
  const context = vm.createContext({ URL, ...globals });
  vm.runInContext(source, context, { filename: 'event-effects.js' });
  return context.EventEffects;
}

// Record canvas geometry without needing a DOM, browser, image library, or graphics backend.
function recordingContext() {
  const calls = [], stack = [];
  const ctx = { calls, globalAlpha: 0.8, globalCompositeOperation: 'multiply', lineWidth: 2, lineCap: 'butt', strokeStyle: '#123456', fillStyle: '#654321' };
  const styles = ['globalAlpha', 'globalCompositeOperation', 'lineWidth', 'lineCap', 'strokeStyle', 'fillStyle'];
  function record(method, args) {
    for (const value of args) if (typeof value === 'number') assert.ok(Number.isFinite(value), `${method} received a nonfinite coordinate`);
    calls.push({ method, args: [...args], alpha: ctx.globalAlpha, stroke: ctx.strokeStyle });
  }
  ctx.save = () => stack.push(Object.fromEntries(styles.map(key => [key, ctx[key]])));
  ctx.restore = () => {
    assert.ok(stack.length, 'canvas restore must have a matching save');
    Object.assign(ctx, stack.pop());
  };
  for (const method of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'fill', 'stroke', 'fillRect', 'translate', 'rotate']) {
    ctx[method] = (...args) => record(method, args);
  }
  ctx.drawImage = (_image, ...args) => record('drawImage', args);
  ctx.createRadialGradient = (...args) => {
    record('createRadialGradient', args);
    return { addColorStop(offset, color) { assert.ok(offset >= 0 && offset <= 1); assert.equal(typeof color, 'string'); } };
  };
  ctx.assertRestored = () => {
    assert.equal(stack.length, 0);
    assert.equal(ctx.globalAlpha, 0.8);
    assert.equal(ctx.globalCompositeOperation, 'multiply');
    assert.equal(ctx.lineWidth, 2);
    assert.equal(ctx.strokeStyle, '#123456');
  };
  return ctx;
}

function render(manager, overrides = {}) {
  const ctx = recordingContext();
  manager.draw(ctx, { ...defaults, ...overrides });
  ctx.assertRestored();
  return ctx;
}

function merge(a, b, t = 1) {
  const keep = a.m >= b.m ? a : b, gone = keep === a ? b : a;
  return { type: 'merge', t, a: a.id, b: b.id, into: keep.id, gone: gone.id,
    before: [a, b], after: [{ ...keep, m: a.m + b.m }] };
}

test('merge metadata distinguishes swallowing, impact and stellar merging using the physics mass threshold', () => {
  const manager = loadEngine().create();
  const cases = [
    [merge(star, planet, 1), 'swallow'],
    [merge(planet, moon, 2), 'impact'],
    [merge(star, { ...star, id: 3, m: 0.4 }, 3), 'stellar'],
    // Descriptive kind can lag behind an edited mass; physics classifies by mass.
    [merge({ ...planet, m: 0.1 }, moon, 4), 'swallow']
  ];
  for (const [event, mode] of cases) {
    const result = manager.add(event);
    assert.equal(result.mode, mode);
    assert.equal(result.ownerId, event.into);
    assert.equal(manager.diagnostics.lastAdded.mode, mode);
  }
  assert.equal(manager.state.effects.length, cases.length);
});

test('tidal material follows current body positions and turns toward the current perturbing star', () => {
  const manager = loadEngine().create();
  manager.add(rip);
  manager.update(0.35, { playing: true });
  const right = render(manager).calls.filter(call => call.method === 'translate');
  assert.ok(right.length > 0, 'missing texture should still produce material fragments');
  assert.ok(right.every(call => call.args[0] > 100), 'star to the right pulls material to the right');
  const left = render(manager, { bodies: [{ ...star, x: -80 }, planet] }).calls.filter(call => call.method === 'translate');
  assert.ok(left.every(call => call.args[0] < 100), 'the stream must not retain a stale direction');
  const moved = render(manager, { bodies: [{ ...star, x: 180, y: 50 }, { ...planet, x: 100, y: 50 }], quality: 2 });
  assert.ok(moved.calls.some(call => call.method === 'arc' && call.args[0] === 200 && call.args[1] === 150), 'accent attaches to the current projected planet');
});

test('effects detach when their owner or required partner disappears and stay gone if an ID later reappears', () => {
  const manager = loadEngine().create();
  manager.add(rip);
  manager.update(0.2, { playing: true });
  render(manager, { bodies: [star] });
  assert.equal(manager.state.effects.length, 0);
  assert.equal(manager.diagnostics.detached, 1);
  const reappeared = render(manager, { bodies: [star, { ...planet, x: 500 }] });
  assert.equal(reappeared.calls.length, 0, 'an observed removal must not reconnect to a reused numeric ID');
  manager.add({ type: 'moon', t: 2, id: moon.id, from: planet.id });
  render(manager, { bodies: [star, moon] });
  assert.equal(manager.state.effects.length, 0, 'accretion requires its surviving source planet');
});

test('merge effects need only the current survivor and never project the gone body as a live object', () => {
  const manager = loadEngine().create();
  manager.add(merge(star, planet));
  manager.update(0.1, { playing: true });
  const projectedIds = [];
  render(manager, { bodies: [star], project: b => { projectedIds.push(b.id); return { x: b.x + 100, y: b.y + 100 }; } });
  assert.equal(manager.diagnostics.drawn, 1);
  assert.ok(projectedIds.length > 0);
  assert.ok(projectedIds.every(id => id === star.id), 'only the surviving body supplies the current attachment and projection basis');
  render(manager, { bodies: [] });
  assert.equal(manager.state.effects.length, 0);
});

test('pausing freezes elapsed visual time and the rendered effect; invalid frame deltas do not advance it', () => {
  const manager = loadEngine().create();
  manager.add(rip);
  manager.update(0.3, { playing: true });
  const before = render(manager).calls;
  manager.update(20, { playing: false });
  assert.equal(manager.state.effects[0].elapsed, 0.3);
  assert.deepEqual(render(manager).calls, before);
  for (const dt of [-1, NaN, Infinity, undefined]) manager.update(dt, { playing: true });
  assert.equal(manager.state.effects[0].elapsed, 0.3);
  manager.update(0.1, { playing: true });
  assert.ok(manager.state.effects[0].elapsed > 0.3);
});

test('reduced motion draws a short static accent without particles or a flash', () => {
  const manager = loadEngine().create();
  manager.add(merge(star, planet));
  manager.update(0.1, { playing: true, reducedMotion: true });
  const ctx = render(manager);
  assert.equal(manager.diagnostics.particles, 0);
  assert.ok(ctx.calls.some(call => call.method === 'arc'));
  assert.ok(!ctx.calls.some(call => call.method === 'createRadialGradient' || call.method === 'translate'));
  manager.update(10, { playing: false, reducedMotion: true });
  assert.deepEqual(render(manager).calls, ctx.calls, 'paused reduced-motion accents remain static');
  manager.update(0.3, { playing: true, reducedMotion: true });
  assert.equal(manager.state.effects.length, 0);
});

test('quality levels reduce particle work and minimal quality retains only a local accent', () => {
  const manager = loadEngine().create();
  manager.add(rip);
  manager.update(0.35, { playing: true });
  render(manager, { quality: 0 }); const high = manager.diagnostics.particles;
  render(manager, { quality: 1 }); const low = manager.diagnostics.particles;
  const minimal = render(manager, { quality: 2 });
  assert.ok(high > low && low > 0);
  assert.equal(manager.diagnostics.particles, 0);
  assert.ok(minimal.calls.some(call => call.method === 'arc'));
  assert.ok(!minimal.calls.some(call => call.method === 'fillRect' || call.method === 'translate'));
});

test('effect geometry remains local even when the perturbing star is far off screen', () => {
  const manager = loadEngine().create();
  manager.add(rip);
  manager.update(0.65, { playing: true });
  const ctx = render(manager, { bodies: [{ ...star, x: 1e12 }, planet] });
  const positions = ctx.calls.filter(call => call.method === 'translate').map(call => call.args);
  assert.ok(positions.length > 0);
  for (const [x, y] of positions) assert.ok(Math.hypot(x - 100, y - 100) < 64, 'particles should not bridge an astronomical screen distance');
  manager.reset(); manager.add(merge(star, planet)); manager.update(0.1, { playing: true });
  const flash = render(manager).calls.filter(call => call.method === 'fillRect');
  assert.ok(flash.length > 0);
  assert.ok(flash.every(call => call.args[2] < 40 && call.args[3] < 40), 'swallowing does not produce a fullscreen flash');
});

test('bounded queues, duplicate suppression and resets prevent stale event buildup across runs', () => {
  const manager = loadEngine().create({ maxEffects: 3 });
  assert.ok(manager.add(rip));
  assert.equal(manager.add(rip), false);
  for (let t = 2; t <= 5; t++) manager.add({ ...rip, t });
  assert.equal(manager.state.effects.length, 3);
  assert.equal(manager.diagnostics.overflow, 2);
  assert.equal(manager.diagnostics.duplicate, 1);
  manager.reset();
  assert.equal(manager.state.effects.length, 0);
  assert.equal(manager.diagnostics.lastAdded, null);
  assert.ok(manager.add(rip), 'replaying a run may emit the exact same event again');
  manager.update(10, { playing: true });
  assert.equal(manager.state.effects.length, 0);
  assert.equal(manager.add({ type: 'rip', id: 1 }), false);
  assert.equal(manager.add({ type: 'unknown' }), false);
});

test('matching event data produces repeatable geometry without leaking canvas state, in both themes', () => {
  const engine = loadEngine();
  const a = engine.create(), b = engine.create();
  for (const manager of [a, b]) { manager.add(rip); manager.update(0.32, { playing: true }); }
  assert.deepEqual(render(a).calls, render(b).calls);
  const dark = render(a, { quality: 2, theme: 'dark' }).calls.find(call => call.method === 'arc');
  const light = render(a, { quality: 2, theme: 'light' }).calls.find(call => call.method === 'arc');
  assert.notEqual(dark.stroke, light.stroke, 'light backgrounds need a darker accent');
  const exposed = a.state; exposed.effects[0].elapsed = 999;
  assert.equal(a.state.effects[0].elapsed, 0.32, 'diagnostic snapshots must not mutate the running effect');
});

test('the fragment texture is shared, while loading failure retains readable procedural fragments', () => {
  let requests = 0;
  class LoadedImage {
    naturalWidth = 32; naturalHeight = 24;
    set src(url) { assert.match(url, /debris-fragment\.webp$/); requests++; this.onload(); }
  }
  const engine = loadEngine({ Image: LoadedImage });
  const manager = engine.create(); engine.create();
  assert.equal(requests, 1, 'instances share one texture request');
  manager.add(rip); manager.update(0.3, { playing: true });
  assert.equal(manager.diagnostics.texture, 'ready');
  assert.ok(render(manager).calls.some(call => call.method === 'drawImage'));
  class FailedImage { set src(_url) { this.onerror(); } }
  const fallback = loadEngine({ Image: FailedImage }).create();
  fallback.add(rip); fallback.update(0.3, { playing: true });
  const ctx = render(fallback);
  assert.equal(fallback.diagnostics.texture, 'unavailable');
  assert.ok(fallback.diagnostics.particles > 0);
  assert.ok(ctx.calls.some(call => call.method === 'fill'));
  assert.ok(!ctx.calls.some(call => call.method === 'drawImage'));
});

test('invalid projections are discarded instead of sending NaN geometry to the canvas', () => {
  const manager = loadEngine().create();
  manager.add(rip);
  const ctx = render(manager, { project: () => ({ x: NaN, y: 20 }) });
  assert.equal(ctx.calls.length, 0);
  assert.equal(manager.state.effects.length, 0);
});
