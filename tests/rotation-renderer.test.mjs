import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/body-renderer.js', import.meta.url), 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
const noop = () => {};

// The mock supplies a continuous periodic texture to the real projection code, records
// its pixels and frame selections, and checks that drawing restores caller canvas state.
// It deliberately does not approximate browser compositing or visual quality.
async function loadRenderer({ missing = [] } = {}) {
  const canvases = [], frames = [], draws = [];
  let pixelReads = 0;
  function makeCanvas() {
    const canvas = { width: 0, height: 0, signature: '', id: canvases.length };
    const stack = [];
    const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1,
      fillStyle: '#000', strokeStyle: '#000', lineCap: 'butt', lineJoin: 'miter' };
    const styles = Object.keys(ctx);
    ctx.save = () => stack.push(Object.fromEntries(styles.map(key => [key, ctx[key]])));
    ctx.restore = () => { assert.ok(stack.length, 'unbalanced canvas restore'); Object.assign(ctx, stack.pop()); };
    const mark = (method, args) => {
      for (const arg of args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg), `${method} received ${arg}`);
      canvas.signature = digest(canvas.signature + JSON.stringify([method, args, ctx.globalAlpha, ctx.globalCompositeOperation]));
    };
    for (const name of ['beginPath', 'closePath', 'arc', 'clip', 'fillRect', 'moveTo', 'lineTo', 'stroke', 'fill', 'translate', 'rotate', 'quadraticCurveTo']) {
      ctx[name] = (...args) => mark(name, args);
    }
    ctx.clearRect = (...args) => { canvas.signature = ''; mark('clearRect', args); };
    ctx.drawImage = (image, ...args) => {
      canvas.lastImage = image;
      draws.push({ target: canvas.id, image, args: [...args], alpha: ctx.globalAlpha, operation: ctx.globalCompositeOperation });
      mark('drawImage', [image.signature || image.name, ...args]);
    };
    ctx.createImageData = (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
    ctx.getImageData = (_x, _y, width, height) => {
      pixelReads++;
      const result = ctx.createImageData(width, height);
      // Smooth, nonuniform albedo that is periodic at the longitude seam.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        const value = Math.round(125 + 65 * Math.cos(x / width * Math.PI * 2) * Math.cos((y / height - .5) * Math.PI));
        result.data[p] = value; result.data[p + 1] = value; result.data[p + 2] = value; result.data[p + 3] = 255;
      }
      return result;
    };
    ctx.putImageData = (pixels, x, y) => {
      const hash = digest(pixels.data);
      frames.push({ target: canvas.id, x, y, width: pixels.width, height: pixels.height, hash, data: pixels.data.slice() });
      mark('putImageData', [hash, x, y]);
    };
    ctx.createRadialGradient = () => ({ addColorStop: noop });
    ctx.assertRestored = () => { assert.equal(stack.length, 0); assert.equal(ctx.globalAlpha, .7); assert.equal(ctx.globalCompositeOperation, 'multiply'); };
    canvas.getContext = () => ctx;
    canvas.context = ctx;
    canvases.push(canvas);
    return canvas;
  }
  class Image {
    naturalWidth = 256;
    naturalHeight = 128;
    set src(url) {
      this.name = new URL(url).pathname.split('/').at(-1).replace(/\.webp$/, '');
      if (missing.includes(this.name)) this.onerror(); else this.onload();
    }
  }
  const globals = {
    URL, Image, Uint8ClampedArray,
    document: { currentScript: { src: 'http://localhost/src/body-renderer.js' }, createElement: makeCanvas },
    location: { href: 'http://localhost/' }, performance: { now: () => 0 },
    setTimeout: callback => setTimeout(callback, 0),
    requestIdleCallback: callback => setTimeout(() => callback({ timeRemaining: () => 10 }), 0),
  };
  globals.window = globals;
  vm.runInContext(source, vm.createContext(globals));
  const renderer = globals.BodyRenderer;
  await renderer.ready;
  function draw(method, overrides = {}) {
    const output = makeCanvas(), ctx = output.context;
    ctx.globalAlpha = .7; ctx.globalCompositeOperation = 'multiply';
    const result = renderer[method](ctx, { x: 100, y: 100, r: 16, bodyId: 3, id: 'amber',
      spinTime: 0, time: 0, climate: 2, quality: 0, ...overrides });
    ctx.assertRestored();
    return { result, signature: output.signature, canvas: output };
  }
  return { renderer, canvases, frames, draws, draw, makeCanvas, pixelReads: () => pixelReads };
}

const shared = loadRenderer();
const near = (a, b, epsilon = 1e-10) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

test('projected surfaces move inside a fixed silhouette and join smoothly across the rotation seam', async () => {
  const h = await shared, status = h.renderer.status();
  assert.deepEqual([...status.failures], []);
  assert.equal(status.atlasFrames, 512);
  assert.ok(status.rotationReady.planet && status.rotationReady.moon && status.rotationReady.star);
  const frames = h.frames.filter(frame => frame.width === status.atlasFrameSize);
  assert.equal(frames.length, status.atlasFrames);
  const distance = (a, b) => {
    let total = 0;
    for (let p = 0; p < a.length; p += 4) total += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
    return total / (a.length / 4 * 3);
  };
  let opaqueSurfaces = 0;
  for (let start = 0; start < frames.length; start += status.atlasFramesPerRotation) {
    const loop = frames.slice(start, start + status.atlasFramesPerRotation);
    // The scar has changing opacity as it passes behind the limb; all full surfaces retain their sphere mask.
    // Identify full discs by their opaque interiors, independent of atlas preparation priority.
    if (loop[0].data.some((value, index) => index % 4 === 3 && value === 255)) {
      opaqueSurfaces++;
      assert.notEqual(loop[0].hash, loop[16].hash, 'a quarter turn must reveal different surface pixels');
      for (const frame of loop) for (let p = 3; p < frame.data.length; p += 4) assert.equal(frame.data[p], loop[0].data[p]);
      const adjacent = loop.slice(1).map((frame, i) => distance(loop[i].data, frame.data));
      const mean = adjacent.reduce((sum, value) => sum + value, 0) / adjacent.length;
      const seam = distance(loop.at(-1).data, loop[0].data);
      assert.ok(seam < mean * 2 + .1, `loop seam ${seam} should resemble an ordinary frame change ${mean}`);
    }
  }
  assert.equal(opaqueSurfaces, 7, 'five climates, one moon and one stellar surface retain full discs');
});

test('climate blends and scars sample identical rotational positions with normalized frame weights', async () => {
  const h = await shared, begin = h.draws.length;
  assert.equal(h.draw('drawWorld', { bodyId: 103, spinTime: 7.2, climate: 1.3, ripped: true }).result, true);
  const frameDraws = h.draws.slice(begin).filter(draw => draw.args.length === 8 && draw.image.width === 512);
  assert.equal(frameDraws.length, 6, 'two frames for each climate and two for the fracture');
  assert.deepEqual(frameDraws[0].args, frameDraws[2].args);
  assert.deepEqual(frameDraws[1].args, frameDraws[3].args);
  assert.deepEqual(frameDraws[0].args, frameDraws[4].args);
  assert.deepEqual(frameDraws[1].args, frameDraws[5].args);
  near(frameDraws.slice(0, 4).reduce((sum, draw) => sum + draw.alpha, 0), 1);
  near(frameDraws.slice(4).reduce((sum, draw) => sum + draw.alpha, 0), 1);
  const phase = h.renderer.status().recentPhases['planet:103'];
  h.draw('drawWorld', { bodyId: 103, spinTime: 7.2, climate: 3.8 });
  near(h.renderer.status().recentPhases['planet:103'], phase);
});

test('surface phase uses playback time exclusively and remains periodic at every quality level', async () => {
  const h = await shared;
  for (const quality of [0, 1, 2]) for (const type of ['planet', 'moon', 'amber', 'cyan', 'coral']) {
    const method = type === 'planet' || type === 'moon' ? 'drawWorld' : 'drawStar';
    const spec = { bodyId: 104, id: type, moon: type === 'moon', spinTime: 3, quality };
    h.draw(method, { ...spec, time: 0 });
    const phase = h.renderer.status().recentPhases[type + ':104'];
    h.draw(method, { ...spec, time: 100 });
    near(h.renderer.status().recentPhases[type + ':104'], phase);
    const period = h.renderer.status().rotationPeriods[type];
    h.draw(method, { ...spec, spinTime: 3 + period });
    near(h.renderer.status().recentPhases[type + ':104'], phase);
    h.draw(method, { ...spec, spinTime: 3 + period / 4 });
    near((h.renderer.status().recentPhases[type + ':104'] - phase + 1) % 1, .25);
  }
});

test('reduced motion produces the same surface and accents regardless of either clock', async () => {
  const h = await shared;
  for (const method of ['drawWorld', 'drawStar']) {
    const first = h.draw(method, { reducedMotion: true, spinTime: 1, time: 1 });
    const next = h.draw(method, { reducedMotion: true, spinTime: 123, time: 456 });
    assert.equal(first.signature, next.signature);
  }
});

test('drawing reuses bounded scratch layers and never reads pixels after preparation', async () => {
  const h = await shared, reads = h.pixelReads();
  for (let bodyId = 200; bodyId < 250; bodyId++) {
    h.draw('drawWorld', { bodyId, spinTime: bodyId, climate: bodyId % 4 + .25, ripped: true });
    h.draw('drawStar', { bodyId, spinTime: bodyId, id: ['amber', 'cyan', 'coral'][bodyId % 3] });
    const status = h.renderer.status();
    assert.ok(status.scratchLayers <= 16);
    assert.ok(Object.keys(status.recentPhases).length <= 24);
  }
  assert.equal(h.pixelReads(), reads);
  const ctx = h.makeCanvas().context;
  // Repeated frames for one stable body must allocate no new renderer canvases.
  h.renderer.drawWorld(ctx, { x: 0, y: 0, r: 12, bodyId: 999, spinTime: 0 });
  const allocated = h.canvases.length;
  for (let frame = 1; frame < 120; frame++) h.renderer.drawWorld(ctx, { x: 0, y: 0, r: 12, bodyId: 999, spinTime: frame / 30 });
  assert.equal(h.canvases.length, allocated);
});

test('missing rotation maps retain approved static art and missing all art preserves the caller fallback', async () => {
  const missingMaps = ['planet-surface', 'moon-surface', 'star-surface'];
  const h = await loadRenderer({ missing: missingMaps });
  assert.equal(h.renderer.status().atlasFrames, 0);
  for (const spec of [{ climate: 1.3, ripped: true }, { moon: true }]) assert.equal(h.draw('drawWorld', spec).result, true);
  assert.equal(h.draw('drawStar').result, true);
  const none = await loadRenderer({ missing: [...missingMaps, 'star-amber', 'star-cyan', 'star-coral',
    'planet-frozen', 'planet-thawing', 'planet-temperate', 'planet-warming', 'planet-hot', 'planet-stripped', 'moon'] });
  assert.equal(none.draw('drawWorld').result, false);
  assert.equal(none.draw('drawWorld', { moon: true }).result, false);
  assert.equal(none.draw('drawStar').result, false);
});
