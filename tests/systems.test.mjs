import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* The real systems: published numbers, computed motion. These checks run the actual physics core and presets headlessly. */
const html = readFileSync(new URL('../Three-Body Problem.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const context = vm.createContext({});
vm.runInContext(scripts[0], context);
vm.runInContext(scripts[1], context);
const { System, escaping, lumOf, isStar } = context.Physics;
const { PRESETS, bodiesFor } = context.Presets;
const YEAR = 2 * Math.PI;
const REAL = { home: 10, trappist: 0.3, proxima: 1, kepler442: 10, toi700: 2, teegarden: 0.5, alphacen: 50, kepler47: 3, toi1338: 20, gj667: 1, ltt1445: 2 };
const byId = id => PRESETS.find(p => p.id === id);
const followed = ic => ic.find(b => b.meta && b.meta.follow) || ic.find(b => b.kind === 'planet');
const tempOf = (bs, p) => { let F = 0; for (const s of bs) if (s !== p && isStar(s.m)) F += lumOf(s.m, s.meta) / ((s.x - p.x) ** 2 + (s.y - p.y) ** 2); return 288 * Math.pow(F, 0.25); };

test('the preset menu is grouped by how many suns a world lives under, with the classics kept', () => {
  const groups = []; for (const p of PRESETS) if (p.group && !groups.includes(p.group)) groups.push(p.group);
  assert.deepEqual(groups, ['One sun', 'Two suns', 'Three suns', 'Classics']);
  assert.equal(PRESETS.filter(p => p.skies).length, 1, 'only Trisolaris has seeded skies');
  for (const p of PRESETS) {
    assert.match(html, new RegExp(`\\n  ${p.id}: \\{\\n    caption: '`), `${p.id} needs caption copy`);
    assert.match(html, new RegExp(`\\b${p.id}: [\\d.]+`), `${p.id} needs a thumbnail length`);
  }
});

test('every real system carries one followed world and suns with published brightness and tone', () => {
  for (const id of Object.keys(REAL)) {
    const p = byId(id), ic = bodiesFor(p, false), f = followed(ic);
    assert.ok(f && f.kind === 'planet' && f.meta.follow, `${id} follows a planet`);
    assert.equal(ic.filter(b => b.meta && b.meta.follow).length, 1, `${id} follows exactly one world`);
    for (const b of ic) if (isStar(b.m)) { assert.ok(b.meta.lum > 0, `${id}: ${b.meta.name} has a brightness`); assert.ok(['amber', 'cyan', 'coral'].includes(b.meta.tone)); }
    const M = ic.reduce((a, b) => a + b.m, 0); let px = 0, py = 0, pvx = 0, pvy = 0;
    for (const b of ic) { px += b.m * b.x; py += b.m * b.y; pvx += b.m * b.vx; pvy += b.m * b.vy; }
    assert.ok(Math.hypot(px, py) / M < 1e-9 && Math.hypot(pvx, pvy) / M < 1e-9, `${id} starts in its centre-of-mass frame`);
  }
  const suns = byId('home').make().find(b => b.meta.name === 'the Sun');
  assert.equal(lumOf(suns.m, suns.meta), 1);
  assert.equal(lumOf(0.0898, byId('trappist').make()[0].meta), 5.66e-4, 'a measured brightness replaces the mass rule');
  assert.ok(Math.abs(lumOf(1, null) - 1) < 1e-12 && lumOf(0.001, null) === 0, 'the mass rule for stars, nothing for worlds');
});

test('the real systems stay bound and temperate, with no collisions or rips', () => {
  for (const [id, yrs] of Object.entries(REAL)) {
    const p = byId(id), ic = bodiesFor(p, false), S = new System(ic), f = followed(ic);
    const R0 = Math.max(...ic.flatMap(a => ic.map(b => Math.hypot(a.x - b.x, a.y - b.y))));
    let Tmin = Infinity, Tmax = -Infinity, next = 0;
    while (S.t < yrs * YEAR) {
      S.step();
      if (S.t >= next) {
        next += 0.05 * YEAR;
        const bs = S.bodies(), q = bs.find(b => b.id === f.id), T = tempOf(bs, q);
        Tmin = Math.min(Tmin, T); Tmax = Math.max(Tmax, T);
        assert.equal(escaping(bs, R0).size, 0, `${id}: nothing escapes`);
      }
    }
    assert.equal(S.events.length, 0, `${id}: no events in ${yrs} years`);
    assert.ok(Tmin > 235 && Tmax < 320, `${id}: ${f.meta.name || 'the planet'} stays between -38 and 47 °C (saw ${(Tmin - 273).toFixed(0)}..${(Tmax - 273).toFixed(0)})`);
    assert.ok(S.drift() < 1e-9, `${id}: energy drift ${S.drift()}`);
    assert.ok(S.bodies().every(b => b.meta === ic.find(q => q.id === b.id).meta), `${id}: metadata rides along unchanged`);
  }
});

test('Earth receives Earth sunlight and tidally locked worlds are only the close ones', () => {
  const home = byId('home').make(), earth = home.find(b => b.meta.name === 'Earth');
  const T = tempOf(home, earth);
  assert.ok(Math.abs(T - 288) < 5, `Earth near 288 K at 1 AU, saw ${T.toFixed(1)}`);
  assert.ok(!earth.meta.locked && !byId('kepler442').make()[1].meta.locked, 'Earth and Kepler-442 b keep a day and night');
  for (const id of ['trappist', 'proxima']) for (const b of byId(id).make()) if (b.kind === 'planet') assert.ok(b.meta.locked, `${b.meta.name} is tidally locked`);
  assert.deepEqual([...byId('gj667').frame], [2, 3, 4], 'Gliese 667 frames C and its worlds');
  assert.ok(byId('gj667').frameSize < 1, 'and sizes the camera to them, not to the 230 AU gap');
});

test('a merged sun keeps a published brightness as the sum of both', () => {
  const S = new System([
    { id: 0, m: 1, x: 0, y: 0, vx: 0, vy: 0, meta: { name: 'one', lum: 0.5, tone: 'amber' } },
    { id: 1, m: 1, x: 1.5e-4, y: 0, vx: 0, vy: 0, meta: { name: 'two', lum: 0.25, tone: 'coral' } },
  ]);
  S.step();
  const ev = S.events.find(e => e.type === 'merge');
  assert.ok(ev, 'touching suns merge');
  const left = S.bodies()[0];
  assert.equal(left.meta.lum, 0.75);
  assert.equal(left.meta.name, 'one', 'the survivor keeps its own name');
  assert.equal(lumOf(left.m, left.meta), 0.75);
});
