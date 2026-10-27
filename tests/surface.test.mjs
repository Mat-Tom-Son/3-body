import test from 'node:test';
import assert from 'node:assert/strict';
import { DEG, R_SUN_AU, R_EARTH_AU, M_EARTH_SUNS, LATITUDE, localFrame, toLocal, altAz, windOf, starRadiusAU, worldRadiusAU, angularRadius,
  sunDaylight, skyDaylight, standingLongitude, lookVector, SkyLook, phoneLook } from '../src/surface-model.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/* the meridian of a sphere turned by spin angle t about +y, as the 3D view turns its spheres (rotation.y) */
const meridianAt = t => [Math.cos(t), 0, -Math.sin(t)];

test('the observer’s frame is orthonormal, with up along the axis at the pole and on the meridian at the equator', () => {
  for (const [lat, lon] of [[0, 0], [LATITUDE, 1.1], [-0.7, 4], [89.9 * DEG, 2]]) {
    const f = localFrame([0, 1, 0], [1, 0, 0], lat, lon);
    for (const v of [f.up, f.east, f.north]) near(Math.hypot(...v), 1, 1e-12);
    near(dot(f.up, f.east), 0, 1e-12); near(dot(f.up, f.north), 0, 1e-12); near(dot(f.east, f.north), 0, 1e-12);
  }
  const eq = localFrame([0, 1, 0], [1, 0, 0], 0, 0);
  near(eq.up[0], 1); near(eq.north[1], 1, 1e-12);
  const pole = localFrame([0, 1, 0], [1, 0, 0], 90 * DEG, 0);
  near(pole.up[1], 1, 1e-12);
});

test('as the world turns the way the 3D view turns it, its suns rise in the east and set in the west', () => {
  const sun = [1, 0, 0];
  const before = altAz(toLocal(sun, localFrame([0, 1, 0], meridianAt(-0.3), 0, 0)));
  const after = altAz(toLocal(sun, localFrame([0, 1, 0], meridianAt(0.3), 0, 0)));
  assert.equal(windOf(before.az), 'east', 'before noon the sun is in the east');
  assert.equal(windOf(after.az), 'west', 'after noon it is in the west');
  near(before.alt, after.alt, 1e-9);
  const noon = altAz(toLocal(sun, localFrame([0, 1, 0], meridianAt(0), 0, 0)));
  near(noon.alt, 90 * DEG, 1e-9);
  /* at 30° north on an upright world, a sun in the equatorial plane culminates 60° up, due south */
  const high = altAz(toLocal(sun, localFrame([0, 1, 0], meridianAt(0), LATITUDE, 0)));
  near(high.alt, 60 * DEG, 1e-9); assert.equal(windOf(high.az), 'south');
});

test('azimuth runs from north through east, and the eight winds name it', () => {
  near(altAz([0, 1, 0]).az, 0); near(altAz([1, 0, 0]).az, 90 * DEG); near(altAz([0, -1, 0]).az, 180 * DEG); near(altAz([-1, 0, 0]).az, 270 * DEG);
  near(altAz([0, 0, 1]).alt, 90 * DEG);
  assert.deepEqual([0, 45, 90, 135, 180, 225, 270, 315, 359].map(d => windOf(d * DEG)), ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north']);
  const v = lookVector(90 * DEG, 0); near(v[0], 1); near(v[2], 0);
});

test('sizes: published radii win; otherwise the mass rules give the Sun and Earth back', () => {
  near(starRadiusAU({ m: 1, meta: { radius: 1 } }), R_SUN_AU, 1e-15);
  near(starRadiusAU({ m: 0.0898, meta: null }) / R_SUN_AU, 0.115, 2e-3, 'the stellar rule gives TRAPPIST-1 back within 4%');
  near(starRadiusAU({ m: 0.09, meta: { radius: 0.119 } }), 0.119 * R_SUN_AU, 1e-15);
  near(worldRadiusAU({ m: M_EARTH_SUNS, meta: null }) / R_EARTH_AU, 1.008, 1e-9);
  near(worldRadiusAU({ m: 0.692 * M_EARTH_SUNS, meta: null }) / R_EARTH_AU, 0.91, 0.005, 'TRAPPIST-1 e from its mass: measured 0.920');
  const below = worldRadiusAU({ m: 2.039 * M_EARTH_SUNS }), above = worldRadiusAU({ m: 2.041 * M_EARTH_SUNS });
  assert.ok(Math.abs(above - below) / below < 1e-3, 'the rocky and icy branches meet');
  near(worldRadiusAU({ m: 1 / 1047.35 }) / R_EARTH_AU, 10.97, 1e-9);
  /* the Sun seen from Earth: 0.2666° in radius */
  near(angularRadius(R_SUN_AU, 1) / DEG, 0.2665, 2e-4);
  assert.ok(angularRadius(1, 0.5) > 1.55, 'inside the body the sky is all body');
});

test('daylight follows the suns: none at night, rising with height and with light received', () => {
  assert.equal(skyDaylight([{ alt: -20 * DEG, flux: 1 }]), 0);
  assert.ok(skyDaylight([{ alt: 30 * DEG, flux: 1 }]) > 0.8);
  assert.ok(sunDaylight(2 * DEG, 1) < sunDaylight(20 * DEG, 1), 'twilight is dimmer than day');
  assert.ok(sunDaylight(30 * DEG, 0.1) < sunDaylight(30 * DEG, 1));
  assert.ok(skyDaylight([{ alt: 30 * DEG, flux: 1 }, { alt: 30 * DEG, flux: 1 }]) <= 1);
  assert.ok(sunDaylight(40 * DEG, 2e-6) < 0.01, 'a sun 230 AU away is a star, not a day');
});

test('the observer is set down where the chosen sun stands a little way up the morning sky', () => {
  const tilted = [Math.sin(0.41), Math.cos(0.41), 0];
  for (const [axis, meridian] of [[[0, 1, 0], [1, 0, 0]], [tilted, [Math.cos(0.41), -Math.sin(0.41), 0]]]) {
    const sun = [0.6, 0, -0.8], lon = standingLongitude(axis, meridian, LATITUDE, sun);
    const { alt, az } = altAz(toLocal(sun, localFrame(axis, meridian, LATITUDE, lon)));
    near(alt, 24 * DEG, 1.5 * DEG); assert.ok(az < Math.PI, 'morning: the sun is in the eastern half');
  }
});

test('looking around: a drag grabs the sky, a fling coasts and stops, facing turns smoothly, reduced motion stills it', () => {
  const look = new SkyLook(), az0 = look.az;
  look.drag(100, 0, 0.1); near(look.az, az0 - 10 * DEG, 1e-12);
  look.drag(0, -1e5, 0.1); near(look.alt, -30 * DEG, 1e-12, 'the head stops short of looking straight down');
  look.fling(500, 0, 0.1); for (let i = 0; i < 400; i++) look.update(1 / 60, false);
  assert.equal(look.vaz, 0, 'the fling comes to rest');
  look.face(2, 0.3); for (let i = 0; i < 300; i++) look.update(1 / 60, false);
  const off = look.az - 2; near(off - 2 * Math.PI * Math.round(off / (2 * Math.PI)), 0, 1e-3); near(look.alt, 0.3, 1e-3);
  look.fling(500, 0, 0.1); const before = look.az; look.update(1 / 60, true); near(look.az, before, 1e-12);
  look.zoom(10); assert.equal(look.fov, 100); look.zoom(0.001); assert.equal(look.fov, 12);
});

test('the ground’s day: a sun returns to the same place after one solar day, rising in the east, and a locked world has none', async () => {
  const { spinFrame, solarDay } = await import('../src/surface-model.js');
  const star = { id: 0, m: 1, x: 0, y: 0, meta: null }, lum = () => 1, at = t => ({ id: 1, m: 3e-6, x: Math.cos(t), y: Math.sin(t), meta: { days: 365.25 } });
  const day = solarDay(at(0), [star], lum);
  assert.equal(day.locked, false); near(day.year, 2 * Math.PI, 1e-3); near(day.solar, day.year / 365.25, 1e-9);
  /* the world moves anticlockwise round its sun (n = 1 here); the ground turns by omega; its sun is where it was a day later */
  const sunAlt = t => {
    const p = at(t), dir = [-p.x, 0, p.y], len = Math.hypot(...dir), { axis, meridian } = spinFrame(day.omega * t, 0.41);
    return altAz(toLocal(dir.map(v => v / len), localFrame(axis, meridian, LATITUDE, 1.0)));
  };
  const a = sunAlt(0.3), b = sunAlt(0.3 + day.solar);
  near(a.alt, b.alt, 0.01); near(a.az, b.az, 0.02);
  /* through the day the sun climbs on the eastern side and sinks on the western */
  let east = 0, west = 0;
  for (let k = 0; k < 48; k++) { const t = 0.3 + k * day.solar / 48, p = sunAlt(t), q = sunAlt(t + day.solar / 480); if (p.alt > 0) { if (q.alt > p.alt) east += p.az < Math.PI ? 1 : -1; else west += p.az > Math.PI ? 1 : -1; } }
  assert.ok(east > 0 && west > 0, `rising in the east, setting in the west (${east}, ${west})`);
  assert.equal(solarDay({ ...at(0), meta: { locked: true } }, [star], lum).locked, true);
  assert.equal(solarDay(at(0), [], lum), null);
  near(solarDay({ ...at(0), meta: null }, [star], lum).days, 30, 0);
});

test('drawn sizes keep the real order: the Sun outranks Jupiter, Jupiter Earth, Earth the Moon, a red dwarf its worlds', async () => {
  const { readFileSync } = await import('node:fs'), vm = await import('node:vm');
  const html = readFileSync(new URL('../Three-Body Problem.html', import.meta.url), 'utf8');
  const code = html.slice(html.indexOf('const R_EARTH_PER_SUN'), html.indexOf('/* what true size means'));
  const c = vm.createContext({ clamp: (v, a, b) => Math.min(b, Math.max(a, v)), isStar: m => m >= 0.05, isWorld: b => b.kind === 'planet' || b.kind === 'moon', Math });
  vm.runInContext(code + '; this.radiusEarth = radiusEarth; this.drawnRadius = drawnRadius;', c);
  const sun = { m: 1, meta: { radius: 1 } }, jupiter = { m: 1 / 1047.35, kind: null, meta: { radius: 10.973 } };
  const earth = { m: M_EARTH_SUNS, kind: 'planet', meta: { radius: 1 } }, moon = { m: 0.0123 * M_EARTH_SUNS, kind: 'moon', meta: null };
  const R = b => c.drawnRadius(b);
  assert.ok(R(sun) > R(jupiter) && R(jupiter) > R(earth) && R(earth) > R(moon), [sun, jupiter, earth, moon].map(R).join(' > '));
  near(R(sun) / R(earth), Math.pow(109.08, 0.3), 1e-9);
  const trappist = { m: 0.0898, meta: { radius: 0.1192 } }, g = { m: 1.321 * M_EARTH_SUNS, kind: 'planet', meta: { radius: 1.129 } };
  assert.ok(R(trappist) > 2 * R(g), 'TRAPPIST-1 is drawn well over twice the width of its largest world');
  /* the page's rules are the surface view's rules */
  for (const m of [0.3, 0.7, 1.4]) near(c.radiusEarth({ m, meta: null }) * R_EARTH_AU, starRadiusAU({ m, meta: null }) , 1e-6);
  for (const mE of [0.3, 1.5, 5, 40, 300]) near(c.radiusEarth({ m: mE * M_EARTH_SUNS, kind: 'planet', meta: null }) * R_EARTH_AU, worldRadiusAU({ m: mE * M_EARTH_SUNS, meta: null }), 1e-12);
});

test('every real body wears the surface its physics calls for, the same in both views', async () => {
  const { readFileSync } = await import('node:fs'), vm = await import('node:vm');
  const html = readFileSync(new URL('../Three-Body Problem.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const ctx = vm.createContext({ window: {} }); vm.runInContext(scripts[0], ctx); vm.runInContext(scripts[1], ctx);
  vm.runInContext(readFileSync(new URL('../src/surfaces.js', import.meta.url), 'utf8'), ctx);
  const g = ctx.Presets ? ctx : ctx.window, { PRESETS, bodiesFor } = g.Presets, { lumOf, isStar } = g.Physics, { surfaceOf } = ctx.window.Surfaces;
  const mapOf = (id, name) => {
    const list = bodiesFor(PRESETS.find(p => p.id === id), false), b = list.find(q => (q.meta && q.meta.name) === name);
    let F = 0; for (const s of list) if (s !== b && isStar(s.m)) F += lumOf(s.m, s.meta) / ((s.x - b.x) ** 2 + (s.y - b.y) ** 2);
    const R = isStar(b.m) && b.kind !== 'planet' ? 0 : worldRadiusAU(b) / R_EARTH_AU;
    return surfaceOf(b, F, R).name;
  };
  const expect = {
    home: { 'the Sun': 'star-surface', Earth: 'planet-surface', Jupiter: 'v5/giant-jovian' },
    trappist: { 'TRAPPIST-1': 'v5/star-m-dwarf', 'TRAPPIST-1 b': 'v5/planet-barren', 'TRAPPIST-1 e': 'v5/planet-eyeball', 'TRAPPIST-1 h': 'v5/moon-icy' },
    proxima: { 'Proxima b': 'v5/planet-eyeball', 'Proxima d': 'v5/planet-barren' },
    kepler442: { 'Kepler-442': 'v5/star-k-dwarf', 'Kepler-442 b': 'v5/planet-arid' },
    alphacen: { 'Alpha Centauri A': 'star-surface', 'Alpha Centauri B': 'v5/star-k-dwarf' },
    kepler47: { 'Kepler-47 c': 'v5/giant-neptunian', 'Kepler-47 d': 'v5/giant-jovian' },
    gj667: { 'Gliese 667 C': 'v5/star-m-dwarf', 'Gliese 667 Cc': 'v5/planet-eyeball' },
    ltt1445: { 'LTT 1445 Ab': 'v5/planet-barren', 'LTT 1445 Ad': 'v5/planet-eyeball' },
    toi700: { 'TOI-700 c': 'v5/giant-neptunian', 'TOI-700 d': 'v5/planet-eyeball' },
  };
  for (const [id, bodies] of Object.entries(expect)) for (const [name, map] of Object.entries(bodies)) assert.equal(mapOf(id, name), map, `${id}: ${name}`);
});

test('looking with the phone: held upright it looks at the horizon, tipped back it looks up, turned it turns the heading', () => {
  const up = phoneLook(0, 90, 0); near(up.alt, 0, 1e-12); near(up.az, 0, 1e-12);
  near(phoneLook(0, 135, 0).alt, 45 * DEG, 1e-9, 'tipping the top of the phone back raises the view');
  near(phoneLook(0, 45, 0).alt, -45 * DEG, 1e-9);
  near(phoneLook(0, 0, 0).alt, -90 * DEG, 1e-9, 'flat on a table, face up, the camera looks at the ground');
  near(phoneLook(90, 90, 0).az, -90 * DEG, 1e-9, 'alpha grows anticlockwise, so the heading turns the other way');
  const held = new SkyLook(); held.turnBy(0.2, 2); near(held.az, 0.2, 1e-12); near(held.alt, 88 * DEG, 1e-12);
});

test('the ground underfoot matches the world: shore, broken ice, bare ice, lineae, hardpan and lava, walked by the climate', async () => {
  const { groundTiles, GLOW_OF } = await import('../src/surface-model.js');
  const { existsSync } = await import('node:fs');
  const at = (surface, climate, more) => groundTiles({ surface, climate, ...more });
  assert.deepEqual(at('v5/planet-ocean', 2), ['v6/ground-shore', 'v6/ground-shore', 0]);
  assert.deepEqual(at('v5/planet-ocean', 0.5), ['v5/ground-snow', 'v6/ground-shore', 0.5], 'a cold sea freezes over');
  assert.deepEqual(at('v5/planet-eyeball', 2), ['v6/ground-ice-margin', 'v6/ground-ice-margin', 0]);
  assert.equal(at('v5/planet-eyeball', 0)[0], 'v6/ground-blue-ice');
  assert.deepEqual(at('v5/moon-icy', 0), ['v6/ground-blue-ice', 'v6/ground-blue-ice', 0], 'a frozen locked world has no wind to shape snow');
  assert.deepEqual(at('v5/moon-icy', 0, { moon: true }), ['v6/ground-ice-lineae', 'v6/ground-ice-lineae', 0]);
  assert.deepEqual(at('v5/planet-arid', 2), ['v6/ground-hardpan', 'v6/ground-hardpan', 0]);
  assert.deepEqual(at('v5/planet-arid', 4), ['v6/ground-hardpan', 'v5/ground-scorched', 1]);
  assert.deepEqual(at('v5/planet-lava', 2), ['v6/ground-lava', 'v6/ground-lava', 0]);
  assert.deepEqual(at('v5/planet-terran-b', 2.5), ['v5/ground-grassland', 'v5/ground-desert', 0.5], 'Earth-like worlds keep the climate ladder');
  assert.deepEqual(groundTiles({ surface: 'v5/planet-ocean', climate: 2, gas: true }), ['v5/ground-cloudtops', 'v5/ground-cloudtops', 0]);
  /* every tile and mask named here ships */
  const names = new Set([...['v5/planet-ocean', 'v5/planet-eyeball', 'v5/moon-icy', 'v5/planet-arid', 'v5/planet-lava', 'v5/planet-barren', 'x']
    .flatMap(s => [0, 0.5, 1.5, 2.5, 3.2, 4].flatMap(c => [false, true].flatMap(moon => groundTiles({ surface: s, climate: c, moon }).slice(0, 2)))), ...Object.values(GLOW_OF)]);
  for (const n of names) assert.ok(existsSync(new URL(`../public/assets/bodies/${n}.webp`, import.meta.url)), n + ' ships');
});
