import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../Three-Body Problem.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const context = vm.createContext({});
vm.runInContext(scripts[0], context);
vm.runInContext(scripts[1], context);
const { System } = context.Physics;
const { trisolarisBodies, skyFromSeed } = context.Presets;
const body = (id, m, x, y, vx = 0, vy = 0, extra = {}) => ({ id, m, x, y, vx, vy, ...extra });
const near = (a, b, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b)), `${a} != ${b}`);

test('collision metadata captures both bodies at contact without changing mass or momentum', () => {
  const input = [body(0, 1, 0, 0, .01, .02), body(3, 3e-6, .003, 0, -.1, 2, { kind: 'planet' })];
  const system = new System(input);
  system.step();
  const event = system.events.find(e => e.type === 'merge');
  assert.ok(event, 'a world inside the stellar surface must merge');
  assert.equal(event.before.length, 2);
  assert.equal(event.after.length, 1);
  assert.equal(event.gone, 3);
  assert.equal(event.into, 0);
  assert.equal(event.star, true);
  const a = event.before, survivor = event.after[0];
  near(survivor.m, a[0].m + a[1].m);
  for (const axis of ['vx', 'vy']) near(survivor.m * survivor[axis], a[0].m * a[0][axis] + a[1].m * a[1][axis]);
  assert.ok(!system.bodies().some(b => b.id === event.gone));
  const recordedX = survivor.x;
  for (let i = 0; i < 10; i++) system.step();
  assert.equal(event.after[0].x, recordedX, 'effect snapshots must not move when the system advances');
});

test('tidal stripping records a surviving planet and its ten-percent debris budget', () => {
  const system = new System([body(0, 1, 0, 0), body(3, 3e-6, .0055, 0, 0, 13, { kind: 'planet' })]);
  system.step();
  const event = system.events.find(e => e.type === 'rip');
  assert.ok(event, 'Roche crossing should emit a rip event');
  const before = event.before.find(b => b.id === event.id), after = event.after.find(b => b.id === event.id);
  near(after.m, before.m * .9);
  near(after.debris, before.m * .1);
  assert.equal(after.ripped, true);
  assert.equal(system.n, 2);
  assert.equal(event.by, 0);
});

test('moon formation transfers the recorded debris into a new body and preserves its parent', () => {
  const system = new System([body(0, 1, 0, 0), body(3, 2.7e-6, 1, 0, 0, 1, { kind: 'planet', ripped: true, debris: 3e-7 })]);
  system.step();
  const event = system.events.find(e => e.type === 'moon');
  assert.ok(event);
  const moon = event.after.find(b => b.id === event.id), parent = event.after.find(b => b.id === event.from);
  assert.equal(event.from, 3);
  assert.equal(moon.kind, 'moon');
  near(moon.m, event.before[0].debris);
  assert.equal(parent.debris, 0);
  assert.equal(system.n, 3);
  assert.ok(system.bodies().some(b => b.id === parent.id));
});

test('a real curated sky reaches stripping, moon formation and swallowing with complete render metadata', () => {
  const system = new System(trisolarisBodies(skyFromSeed('wren')));
  const end = 16 * 2 * Math.PI;
  while (system.t < end && system.steps < 120000) system.step();
  assert.ok(system.t >= end, 'fixture should finish in the bounded step budget');
  for (const type of ['rip', 'moon', 'merge']) assert.ok(system.events.some(e => e.type === type), `missing ${type}`);
  for (const event of system.events) {
    assert.ok(event.before.length && event.after.length);
    for (const b of [...event.before, ...event.after]) for (const key of ['x', 'y', 'm', 'vx', 'vy']) assert.ok(Number.isFinite(b[key]), `${event.type}.${key}`);
  }
});
