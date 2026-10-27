import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from '../scripts/build.mjs';
import { createAppServer } from '../server.mjs';
import { CameraRig, basisOf, cameraOffset, fitDistance, climateTint, atmosphereTint, spinAngle, toneOf, SPIN_PERIODS } from '../src/sky3d-model.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b)), `${a} != ${b}`);
const fit = { tanH: 0.6, tanV: 0.4, playing: true };

test('the main page loads the 3D module on demand through an import map, and keeps its flat chart intact', () => {
  const html = readFileSync(new URL('../Three-Body Problem.html', import.meta.url), 'utf8');
  assert.match(html, /<script type="importmap">\{ "imports": \{ "three": "\.\/vendor\/three\.module\.js" \} \}<\/script>/);
  assert.match(html, /import\(new URL\('src\/sky3d\.js', location\.href\)\.href\)/, 'three.js is only fetched when the 3D view is chosen');
  assert.match(html, /id="sky3d" aria-hidden="true" hidden/);
  assert.match(html, /id="modeSeg"[\s\S]*data-v="flat"[\s\S]*data-v="3d"/);
  assert.match(html, /mode: '3d', drift: true, chosen: false/, '3D is the default view');
  assert.match(html, /else if \(!ui\.view\.chosen\) ui\.view\.mode = '3d';/, 'a saved flat view the person never picked gives way to 3D');
  assert.match(html, /if \(!opts\.silent\) \{ ui\.view\.chosen = true;/, 'picking a view by hand is remembered');
  assert.match(html, /cap = Math\.max\(floor, 0\.24 \* sep \* Ri \/ \(Ri \+ nearR\)\) \/ Ri;[\s\S]*grow = Math\.min\(grow, Math\.max\(1, L\[i\]\.cap\)\)/,
    'spheres are sized by real neighbour distance, so they never pulse or clump, and every sphere in view grows by one shared factor, so sizes keep their proportions');
  assert.doesNotMatch(html, /grid: ui\.view\.grid \}\)/, 'the 3D sky has no grid');
  for (const name of ['drawGrid', 'drawTrails', 'drawBodies', 'drawBodyMarks', 'drawBodyOverlays', 'fitPoints', 'setViewMode', 'followBody']) assert.match(html, new RegExp(`function ${name}\\(`), `${name} must exist`);
});

test('build publishes extra pages with stamped scripts and vendors every three.js file the page or its modules reference', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'three-body-3d-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public')); await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'Three-Body Problem.html'), '<!doctype html><head><script type="importmap">{"imports":{"three":"./vendor/three.module.js"}}</script></head><body><script src="src/view.js"></script></body>');
  await writeFile(path.join(root, 'public/3d.html'), '<!doctype html><script type="module" src="src/view.js"></script>');
  await writeFile(path.join(root, 'src/view.js'), "import { LineSegments2 } from '../vendor/LineSegments2.js';");
  const manifest = await build({ root });
  const paths = manifest.files.map(f => f.path);
  for (const expected of ['3d.html', 'vendor/three.module.js', 'vendor/three.core.js', 'vendor/LineSegments2.js', 'vendor/LineSegmentsGeometry.js', 'vendor/LineMaterial.js']) assert.ok(paths.includes(expected), `${expected} must be published`);
  assert.ok(!paths.some(p => p.includes('OrbitControls')), 'only referenced vendor files are copied');
  assert.match(await readFile(path.join(root, 'dist/3d.html'), 'utf8'), /src\/view\.js\?v=[a-f0-9]{16}/);
  assert.match(await readFile(path.join(root, 'dist/vendor/three.module.js'), 'utf8'), /three\.core\.js/);
  await writeFile(path.join(root, 'src/view.js'), "import x from '../vendor/unknown-lib.js';");
  await assert.rejects(build({ root }), /unknown vendor file/);
});

test('the server serves /3d as a page and still refuses dotfiles and unknown paths', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'three-body-3d-server-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'index.html'), '<title>flat</title>');
  await writeFile(path.join(root, '3d.html'), '<title>Three-Body in 3D</title>');
  const server = await createAppServer({ root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/3d`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Three-Body in 3D/);
  assert.equal((await fetch(`${base}/3d.html`)).status, 200);
  assert.equal((await fetch(`${base}/3d/`)).status, 404);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});

test('the camera rig cuts to a framing, then holds it, and keeps every point in view as they spread', () => {
  const rig = new CameraRig();
  const pts = [[-5, 0], [5, 0], [0, -3], [0, 3]];
  assert.equal(rig.update({ dt: 1 / 60, points: pts, ...fit }), true);
  const first = { ...rig.cur };
  for (let i = 0; i < 120; i++) rig.update({ dt: 1 / 60, points: pts, ...fit });
  near(rig.cur.dist, first.dist, 1e-6); near(rig.cur.tx, 0, 1e-9); near(rig.cur.tz, 0, 1e-9);
  const { right, forward } = basisOf(rig.cur.theta, rig.cur.phi);
  const needed = fitDistance(pts.map(([x, z]) => [x, 0, z]), { ...basisOf(rig.cur.theta, rig.cur.phi), tanH: fit.tanH, tanV: fit.tanV, margin: 1.12, min: 0.05 });
  near(rig.cur.dist, needed, 1e-6);
  assert.ok(right && forward);
  const wide = [[-20, 0], [20, 0]];
  rig.update({ dt: 1 / 60, points: wide, ...fit });
  const after = fitDistance(wide.map(([x, z]) => [x, 0, z]), { ...basisOf(rig.cur.theta, rig.cur.phi), tanH: fit.tanH, tanV: fit.tanV, margin: 1.12 * 0.98, min: 0.05 });
  assert.ok(rig.cur.dist >= after - 1e-9, 'nothing being framed may leave the view, even mid-easing');
});

test('viewer moves: orbit keeps the mode, zoom leaves overview, follow tracks a body, F returns to overview', () => {
  const rig = new CameraRig();
  const pts = [[-2, 0], [2, 0]];
  rig.update({ dt: 1 / 60, points: pts, ...fit });
  const theta = rig.cur.theta;
  rig.orbit(80, -40, 800);
  assert.equal(rig.mode, 'overview'); assert.ok(rig.cur.theta < theta && rig.cur.phi < 0.95);
  rig.dolly(0.5, [1, 0]);
  assert.equal(rig.mode, 'manual'); near(rig.cur.tx, 0.5, 1e-9);
  rig.setMode('follow', 3);
  for (let i = 0; i < 900; i++) rig.update({ dt: 1 / 60, follow: [4, -1], followDefault: 1.5, ...fit });
  near(rig.cur.tx, 4, 1e-3); near(rig.cur.tz, -1, 1e-3); near(rig.cur.dist, 1.5, 1e-2);
  rig.update({ dt: 1 / 60, follow: [40, -10], followDefault: 1.5, ...fit });
  near(rig.cur.tx, 40, 1e-12); near(rig.cur.tz, -10, 1e-12);   // once locked on, a fast body never gets ahead of the camera
  rig.dolly(2); near(rig.followDist, 3, 1e-9);
  rig.setMode('overview'); rig.cutNext(); rig.update({ dt: 1 / 60, points: pts, ...fit });
  near(rig.cur.tx, 0, 1e-9);
  rig.pan(100, 0, 50); near(rig.cur.tx, rig.goal.tx, 1e-12); assert.equal(rig.mode, 'manual');
});

test('fling slows to a stop, idle overview turns slowly only while playing, and reduced motion snaps', () => {
  const rig = new CameraRig();
  const pts = [[-2, 0], [2, 0]];
  rig.update({ dt: 1 / 60, points: pts, ...fit });
  rig.fling(600, 0, 800);
  const t0 = rig.cur.theta; rig.update({ dt: 1 / 60, points: pts, ...fit }); const t1 = rig.cur.theta;
  assert.ok(t1 < t0, 'a rightward fling turns the view');
  for (let i = 0; i < 600; i++) rig.update({ dt: 1 / 60, points: pts, ...fit });
  assert.equal(rig.vTheta, 0, 'inertia dies out');
  const settled = rig.goal.theta;
  for (let i = 0; i < 60; i++) rig.update({ dt: 1 / 60, points: pts, playing: false, tanH: 0.6, tanV: 0.4 });
  near(rig.goal.theta, settled, 1e-9, 'no slow turn while paused');
  rig.idle = 20;
  rig.update({ dt: 1, points: pts, ...fit });
  assert.ok(rig.goal.theta > settled, 'the slow turn starts once the viewer has been idle');
  rig.drift = false; const held = rig.goal.theta; rig.update({ dt: 1, points: pts, ...fit }); near(rig.goal.theta, held, 1e-12);
  rig.setTilt(0.2); rig.update({ dt: 1 / 60, points: pts, reduced: true, tanH: 0.6, tanV: 0.4 }); near(rig.cur.phi, 0.2, 1e-12);
});

test('camera geometry: offsets, basis vectors and fitting agree', () => {
  const off = cameraOffset(0, Math.PI / 2, 5); near(off[0], 0, 1e-12); near(off[1], 0, 1e-12); near(off[2], 5);
  const b = basisOf(0, 0.04); near(b.forward[1], -Math.cos(0.04)); near(b.right[0], 1);
  const basis = { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1], tanH: 1, tanV: 0.5, margin: 1.2, min: 0.5 };
  near(fitDistance([[5, 0, 0], [-5, 0, 0]], basis), 6);
  near(fitDistance([[0, 2, 0]], basis), 4.8);
  near(fitDistance([[0, 0, 3]], basis), 3, 1e-12);
  near(fitDistance([[1, 0, -4]], basis), 0.5, 1e-12);
});

test('tints, spin and tones follow the flat page', () => {
  assert.equal(climateTint(2).amount, 0);
  assert.ok(climateTint(0).amount > 0.5 && climateTint(4).amount > 0.5);
  assert.ok(atmosphereTint(4).rgb[0] > atmosphereTint(2).rgb[0], 'a burning world glows warmer');
  near(spinAngle(36, 24), Math.PI);
  for (const kind of ['planet', 'moon', 'giant', 'amber', 'cyan', 'coral']) assert.ok(Number.isFinite(SPIN_PERIODS[kind]), kind + ' must have a spin period or its sphere gets a NaN rotation and vanishes');
  for (const [kind, period] of Object.entries(SPIN_PERIODS)) assert.ok(period <= 30 && period >= 6, kind + ' turns visibly at 0.25× without blurring at 1×');
  assert.equal(toneOf(4), 'cyan');
});

test('panning shifts the target across the plane, reduced motion stops a fling, and the framing matches fitDistance', () => {
  const rig = new CameraRig(); rig.update({ dt: 0.016, points: [[0, 0], [2, 1]], ...fit });
  rig.shift(1.5, -0.5);
  assert.equal(rig.mode, 'manual', 'a pan leaves overview');
  near(rig.cur.tx, rig.goal.tx); near(rig.goal.tz, rig.cur.tz);
  const follow = new CameraRig(); follow.setMode('follow', 3); follow.shift(5, 5);
  assert.equal(follow.mode, 'manual', 'sliding away from a followed body stops following it');
  assert.equal(follow.goal.tx, 5);
  const twist = new CameraRig(), theta0 = twist.goal.theta; twist.turn(0.3);
  near(twist.cur.theta, theta0 + 0.3); assert.equal(twist.mode, 'overview', 'a twist never changes the mode');
  /* the tilt foreshortens the plane, so a vertical drag covers 1/cos(phi) as much ground as a sideways one */
  const tilt = new CameraRig(); tilt.mode = 'manual'; tilt.cur.theta = tilt.goal.theta = 0; tilt.cur.phi = tilt.goal.phi = 1;
  tilt.pan(0, 10, 100); const vertical = Math.hypot(tilt.goal.tx, tilt.goal.tz);
  const side = new CameraRig(); side.mode = 'manual'; side.cur.theta = side.goal.theta = 0; side.cur.phi = side.goal.phi = 1;
  side.pan(10, 0, 100); near(vertical / Math.hypot(side.goal.tx, side.goal.tz), 1 / Math.cos(1));
  const flung = new CameraRig(); flung.fling(2000, 0, 800);
  const before = flung.goal.theta; flung.update({ dt: 0.016, reduced: true, ...fit });
  assert.equal(flung.vTheta, 0); assert.equal(flung.goal.theta, before, 'no inertia under reduced motion');
  const pts = [[0.3, -1.2], [2, 0.4], [-1, 1]], at = { theta: 0.4, phi: 0.9, tx: 0.2, tz: -0.1 }, env = { ...fit, minHalf: 0.5 };
  const rel = pts.map(([x, z]) => [x - at.tx, 0, z - at.tz]).concat([[0.5, 0, 0], [-0.5, 0, 0], [0, 0, 0.5], [0, 0, -0.5]]);
  near(new CameraRig().distanceFor(pts, at, env, 1), fitDistance(rel, { ...basisOf(at.theta, at.phi), tanH: fit.tanH, tanV: fit.tanV, margin: 1.12, min: 0.05 }));
});

test('two fingers twisting clockwise on screen turn the scene clockwise with them', async () => {
  const THREE = await import('three');
  const screenAngle = theta => {
    const off = cameraOffset(theta, 0.95, 10), cam = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
    cam.position.set(off[0], off[1], off[2]); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    const p = new THREE.Vector3(2, 0, 0).project(cam);
    return Math.atan2(-p.y, p.x);            // screen angle with y down, as pointer events measure it
  };
  const rig = new CameraRig(), before = screenAngle(rig.cur.theta);
  rig.turn(0.1);                             // the page passes the fingers' own (y-down) angle change
  assert.ok(screenAngle(rig.cur.theta) - before > 0.03, 'the scene turns the same way as the fingers');
});
