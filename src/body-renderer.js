/* BodyRenderer: optional Canvas 2D body art, with no simulation state or clock.
 * Both draw methods return false while the required sprite is unavailable, so
 * the caller can keep its existing colored circle. All ctx state is restored.
 * Stars use a 32-frame / 64 px looping atlas prepared in short idle batches.
 * World detail is an overlay: the caller draws its climate-colored disc first.
 */
(() => {
  'use strict';
  const scriptURL = document.currentScript && document.currentScript.src;
  const assetRoot = new URL('../assets/bodies/', scriptURL || new URL('src/body-renderer.js', location.href));
  const TAU = Math.PI * 2;
  const FRAME_SIZE = 64, FRAME_COUNT = 32, ATLAS_COLUMNS = 8, LOOP_SECONDS = 12;
  const MAP_SIZE = 128, WORLD_SIZE = 128, MOTION_STRENGTH = .55;
  const STAR = {
    amber: { rgb: [255, 203, 82], phase: .25 },
    cyan: { rgb: [143, 220, 255], phase: 2.30 },
    coral: { rgb: [255, 138, 107], phase: 4.65 }
  };
  const CLIMATES = ['planet-frozen', 'planet-thawing', 'planet-temperate', 'planet-warming', 'planet-hot'];
  const ASSETS = ['star-amber', 'star-cyan', 'star-coral', ...CLIMATES, 'moon', 'planet-stripped', 'stellar-granulation'];
  const images = Object.create(null), atlases = Object.create(null), blends = Object.create(null), wisps = Object.create(null);
  const failures = [], loaded = new Set();
  let atlasFrames = 0, atlasReady = false, prepared = false, preparationMs = 0;
  let granulation = null, scar = null, worldLayer = null, worldLayerKey = '';

  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const smooth = value => { value = clamp(value, 0, 1); return value * value * (3 - 2 * value); };
  const rgba = (rgb, alpha) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
  const canvas = (width, height) => Object.assign(document.createElement('canvas'), { width, height });
  const hasPosition = spec => spec && Number.isFinite(spec.x) && Number.isFinite(spec.y) && Number.isFinite(spec.r) && spec.r > 0;
  const opacity = value => clamp(finite(value, 1), 0, 1);

  function load(name) {
    return new Promise(resolve => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => { images[name] = image; loaded.add(name); worldLayerKey = ''; resolve(); };
      image.onerror = () => { failures.push(name + ': image unavailable'); resolve(); };
      image.src = new URL(name + '.webp', assetRoot).href;
    });
  }

  function readPixels(image, size) {
    const target = canvas(size, size), context = target.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, size, size);
    return context.getImageData(0, 0, size, size);
  }

  function prepareMap() {
    if (!images['stellar-granulation']) return false;
    const pixels = readPixels(images['stellar-granulation'], MAP_SIZE).data;
    granulation = new Float32Array(MAP_SIZE * MAP_SIZE);
    let mean = 0, variance = 0;
    for (let p = 0; p < granulation.length; p++) {
      granulation[p] = (pixels[p * 4] * .2126 + pixels[p * 4 + 1] * .7152 + pixels[p * 4 + 2] * .0722) / 255;
      mean += granulation[p];
    }
    mean /= granulation.length;
    for (const value of granulation) variance += (value - mean) ** 2;
    const gain = .19 / Math.max(.025, Math.sqrt(variance / granulation.length));
    for (let p = 0; p < granulation.length; p++) granulation[p] = clamp(.5 + (granulation[p] - mean) * gain, 0, 1);
    return true;
  }

  function sample(u, v) {
    u = ((u % 2) + 2) % 2; v = ((v % 2) + 2) % 2;
    if (u > 1) u = 2 - u; if (v > 1) v = 2 - v;
    const xx = u * (MAP_SIZE - 1), yy = v * (MAP_SIZE - 1), x0 = Math.floor(xx), y0 = Math.floor(yy);
    const x1 = Math.min(MAP_SIZE - 1, x0 + 1), y1 = Math.min(MAP_SIZE - 1, y0 + 1), fx = xx - x0, fy = yy - y0;
    return (granulation[y0 * MAP_SIZE + x0] * (1 - fx) + granulation[y0 * MAP_SIZE + x1] * fx) * (1 - fy)
      + (granulation[y1 * MAP_SIZE + x0] * (1 - fx) + granulation[y1 * MAP_SIZE + x1] * fx) * fy;
  }

  function prepareScar() {
    worldLayerKey = '';
    scar = canvas(WORLD_SIZE, WORLD_SIZE);
    const context = scar.getContext('2d'), pixels = context.createImageData(WORLD_SIZE, WORLD_SIZE);
    if (images['planet-stripped'] && images['planet-temperate']) {
      const stripped = readPixels(images['planet-stripped'], WORLD_SIZE).data;
      const temperate = readPixels(images['planet-temperate'], WORLD_SIZE).data;
      for (let y = 0; y < WORLD_SIZE; y++) for (let x = 0; x < WORLD_SIZE; x++) {
        const p = (y * WORLD_SIZE + x) * 4, nx = (x + .5) / WORLD_SIZE * 2 - 1, ny = (y + .5) / WORLD_SIZE * 2 - 1;
        // Only neutral relief from the stripped variant survives this mask.
        // No sea/land color from that temperate image can replace a hot or icy world.
        const zone = Math.exp(-((nx - .52) ** 2 / .13 + (ny + .30) ** 2 / .35));
        const a = stripped[p] * .2126 + stripped[p + 1] * .7152 + stripped[p + 2] * .0722;
        const b = temperate[p] * .2126 + temperate[p + 1] * .7152 + temperate[p + 2] * .0722;
        pixels.data[p] = pixels.data[p + 1] = pixels.data[p + 2] = 20;
        pixels.data[p + 3] = Math.round(clamp(Math.abs(a - b) * 1.5, 0, 75) * zone * smooth((1 - Math.hypot(nx, ny)) / .08));
      }
      context.putImageData(pixels, 0, 0);
    }
    // One small fracture remains legible on a 14–18 px world; its color is neutral.
    context.lineCap = 'round'; context.lineJoin = 'round';
    context.strokeStyle = 'rgba(12,20,25,.24)'; context.lineWidth = 3;
    context.beginPath(); context.moveTo(90, 19); context.lineTo(97, 31); context.lineTo(92, 40);
    context.lineTo(104, 52); context.lineTo(99, 66); context.stroke();
    context.strokeStyle = 'rgba(245,242,230,.11)'; context.lineWidth = .8;
    context.beginPath(); context.moveTo(88, 20); context.lineTo(95, 31); context.lineTo(90, 40); context.lineTo(102, 52); context.stroke();
  }

  function prepareWisps() {
    for (const id of Object.keys(STAR)) {
      const target = canvas(32, 32), context = target.getContext('2d');
      const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
      gradient.addColorStop(0, rgba(STAR[id].rgb, 1)); gradient.addColorStop(.35, rgba(STAR[id].rgb, .32)); gradient.addColorStop(1, rgba(STAR[id].rgb, 0));
      context.fillStyle = gradient; context.fillRect(0, 0, 32, 32); wisps[id] = target;
    }
  }

  function createAtlasBuilder() {
    const overlay = canvas(FRAME_SIZE, FRAME_SIZE), overlayContext = overlay.getContext('2d');
    const pixels = overlayContext.createImageData(FRAME_SIZE, FRAME_SIZE), values = new Float32Array(FRAME_SIZE * FRAME_SIZE);
    const mask = new Float32Array(values.length), u = new Float32Array(values.length), v = new Float32Array(values.length);
    const nx = new Float32Array(values.length), ny = new Float32Array(values.length);
    for (let y = 0; y < FRAME_SIZE; y++) for (let x = 0; x < FRAME_SIZE; x++) {
      const p = y * FRAME_SIZE + x;
      nx[p] = (x + .5) / FRAME_SIZE * 2 - 1; ny[p] = (y + .5) / FRAME_SIZE * 2 - 1;
      const r2 = nx[p] ** 2 + ny[p] ** 2;
      if (r2 >= 1) continue;
      u[p] = .5 + Math.asin(nx[p]) * .27; v[p] = .5 + Math.asin(ny[p]) * .27;
      mask[p] = smooth((1 - Math.sqrt(r2)) / .13) * (.4 + .6 * Math.sqrt(1 - r2));
    }
    return (id, frame) => {
      const phase = TAU * frame / FRAME_COUNT + STAR[id].phase, target = atlases[id], context = target.getContext('2d');
      let mean = 0, weight = 0;
      for (let p = 0; p < values.length; p++) {
        if (!mask[p]) continue;
        // Every time term is periodic, so the last frame blends into the first.
        const flowU = .075 * Math.sin(phase + v[p] * 5) + .022 * Math.sin(2 * phase + u[p] * 3);
        const flowV = .050 * Math.cos(phase + u[p] * 4) + .020 * Math.sin(2 * phase - v[p] * 3);
        const a = sample(u[p] + flowU, v[p] + flowV);
        const b = sample(u[p] * .82 + .11 * Math.cos(phase + 1.2) + .45, v[p] * .85 + .09 * Math.sin(phase) + .22);
        const mix = .5 + .22 * Math.sin(phase + nx[p] * 3 - ny[p] * 2);
        const broad = .5 + .5 * Math.sin(nx[p] * 7 + phase) * Math.cos(ny[p] * 5 - phase);
        values[p] = (a * (1 - mix) + b * mix) * .82 + broad * .18;
        mean += values[p] * mask[p]; weight += mask[p];
      }
      mean /= weight;
      for (let p = 0; p < values.length; p++) {
        const q = p * 4, value = clamp(128 + (values[p] - mean) * 490, 22, 234);
        pixels.data[q] = pixels.data[q + 1] = pixels.data[q + 2] = value;
        pixels.data[q + 3] = Math.round(mask[p] * 255);
      }
      overlayContext.putImageData(pixels, 0, 0);
      const x = frame % ATLAS_COLUMNS * FRAME_SIZE, y = Math.floor(frame / ATLAS_COLUMNS) * FRAME_SIZE;
      context.save(); context.translate(x, y); context.beginPath(); context.arc(32, 32, 32, 0, TAU); context.clip();
      context.fillStyle = rgba(STAR[id].rgb, 1); context.fillRect(0, 0, FRAME_SIZE, FRAME_SIZE);
      context.drawImage(images['star-' + id], 0, 0, FRAME_SIZE, FRAME_SIZE);
      context.globalCompositeOperation = 'soft-light'; context.globalAlpha = MOTION_STRENGTH * 1.55;
      context.drawImage(overlay, 0, 0); context.restore(); atlasFrames++;
    };
  }

  function bakeAtlases() {
    if (!granulation) return Promise.resolve();
    const jobs = [];
    for (const id of Object.keys(STAR)) {
      if (!images['star-' + id]) continue;
      atlases[id] = canvas(ATLAS_COLUMNS * FRAME_SIZE, FRAME_COUNT / ATLAS_COLUMNS * FRAME_SIZE);
      for (let frame = 0; frame < FRAME_COUNT; frame++) jobs.push([id, frame]);
    }
    const bake = createAtlasBuilder();
    return new Promise(resolve => {
      const queue = callback => typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback(callback, { timeout: 150 })
        : window.setTimeout(() => callback({ timeRemaining: () => 0 }), 0);
      const step = deadline => {
        try {
          let count = 0;
          do { const job = jobs.shift(); if (job) bake(job[0], job[1]); count++; }
          while (jobs.length && count < 3 && deadline.timeRemaining() > 3);
          if (jobs.length) queue(step); else { atlasReady = true; resolve(); }
        } catch (error) { failures.push('atlas: ' + error.message); resolve(); }
      };
      queue(step);
    });
  }

  function atlasFrame(context, atlas, frame, x, y, size) {
    context.drawImage(atlas, frame % ATLAS_COLUMNS * FRAME_SIZE, Math.floor(frame / ATLAS_COLUMNS) * FRAME_SIZE,
      FRAME_SIZE, FRAME_SIZE, x, y, size, size);
  }

  function starSurface(id, time, quality, reducedMotion) {
    if (!atlasReady || !atlases[id] || quality >= 2) return images['star-' + id];
    const fps = quality >= 1 ? 15 : 30, step = quality >= 1 ? 2 : 1;
    const tick = reducedMotion ? 0 : Math.floor(time * fps) / fps;
    let cache = blends[id];
    if (!cache) { const target = canvas(FRAME_SIZE, FRAME_SIZE); cache = blends[id] = { canvas: target, context: target.getContext('2d'), key: '' }; }
    const key = tick + ':' + step;
    if (cache.key === key) return cache.canvas;
    cache.key = key;
    const position = (((tick % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS) / LOOP_SECONDS * FRAME_COUNT / step;
    const first = Math.floor(position) * step, second = (first + step) % FRAME_COUNT, mix = position - Math.floor(position);
    const g = cache.context; g.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);
    // Add premultiplied weighted frames in an isolated small layer. Applying
    // caller alpha later avoids the dark fringes / opacity pulse of two fades.
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1 - mix;
    atlasFrame(g, atlases[id], first, 0, 0, FRAME_SIZE);
    if (mix > 0) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = mix; atlasFrame(g, atlases[id], second, 0, 0, FRAME_SIZE); }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    return cache.canvas;
  }

  function drawStar(ctx, spec) {
    if (!ctx || !hasPosition(spec) || !STAR[spec.id] || !images['star-' + spec.id]) return false;
    const alpha = opacity(spec.alpha); if (!alpha) return true;
    const quality = clamp(Math.floor(finite(spec.quality, 0)), 0, 2), time = spec.reducedMotion ? 0 : finite(spec.time, 0);
    const source = starSurface(spec.id, time, quality, !!spec.reducedMotion), { x, y, r } = spec;
    ctx.save(); ctx.globalAlpha *= alpha;
    const baseAlpha = ctx.globalAlpha;
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.clip(); ctx.drawImage(source, x - r, y - r, r * 2, r * 2); ctx.restore();
    // The app retains its existing halo. These small local accents never grow
    // the physical disc and disappear entirely at either reduced quality level.
    if (!quality && !spec.reducedMotion && wisps[spec.id] && r >= 3) {
      const d = STAR[spec.id], light = spec.theme === 'light';
      for (let j = 0; j < 3; j++) {
        const phase = j * TAU / 3, activity = (1 + Math.sin(time + phase)) * .5;
        const angle = d.phase + phase + .065 * Math.sin(time * .62 + j * 1.8), extent = .055 + .055 * activity;
        const distance = r * (1.035 + .025 * Math.sin(time * .73 + j * 2.1)), size = r * .54;
        const wx = x + Math.cos(angle) * distance, wy = y + Math.sin(angle) * distance;
        ctx.globalAlpha = baseAlpha * MOTION_STRENGTH * (.09 + .17 * activity) * (light ? .68 : 1);
        ctx.drawImage(wisps[spec.id], wx - size / 2, wy - size / 2, size, size);
        ctx.globalAlpha = baseAlpha; ctx.lineWidth = Math.max(.45, r * .012); ctx.lineCap = 'round';
        ctx.strokeStyle = rgba(d.rgb, MOTION_STRENGTH * (.18 + .30 * activity) * (light ? .8 : 1));
        ctx.beginPath(); ctx.moveTo(x + Math.cos(angle - extent) * r * .985, y + Math.sin(angle - extent) * r * .985);
        ctx.quadraticCurveTo(x + Math.cos(angle) * r * (1.04 + .06 * activity), y + Math.sin(angle) * r * (1.04 + .06 * activity),
          x + Math.cos(angle + extent) * r * .985, y + Math.sin(angle + extent) * r * .985); ctx.stroke();
      }
    }
    ctx.restore(); return true;
  }

  function worldSurface(climate, moon, ripped) {
    if (moon) return images.moon || null;
    const value = clamp(finite(climate, 2), 0, 4), low = Math.floor(value), high = Math.min(4, low + 1);
    const a = images[CLIMATES[low]], b = images[CLIMATES[high]], mix = value - low;
    if (!a && !b) return null;
    if (!ripped && (!mix || low === high || !a || !b)) return a || b;
    const key = value + ':' + Boolean(ripped);
    if (worldLayerKey === key && worldLayer) return worldLayer;
    if (!worldLayer) worldLayer = canvas(WORLD_SIZE, WORLD_SIZE);
    worldLayerKey = key;
    const g = worldLayer.getContext('2d'); g.clearRect(0, 0, WORLD_SIZE, WORLD_SIZE);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = a && b ? 1 - mix : 1;
    g.drawImage(a || b, 0, 0, WORLD_SIZE, WORLD_SIZE);
    if (a && b && mix > 0) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = mix; g.drawImage(b, 0, 0, WORLD_SIZE, WORLD_SIZE); }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    if (ripped && scar) g.drawImage(scar, 0, 0);
    return worldLayer;
  }

  function drawWorld(ctx, spec) {
    if (!ctx || !hasPosition(spec)) return false;
    const source = worldSurface(spec.climate, !!spec.moon, !!spec.ripped);
    if (!source) return false;
    const alpha = opacity(spec.alpha) * clamp(finite(spec.detail, .7), 0, 1); if (!alpha) return true;
    const { x, y, r } = spec;
    ctx.save(); ctx.globalAlpha *= alpha; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.clip();
    ctx.drawImage(source, x - r, y - r, r * 2, r * 2); ctx.restore(); return true;
  }

  function status() {
    const decodedBytes = Object.values(images).reduce((sum, image) => sum + image.naturalWidth * image.naturalHeight * 4, 0);
    const atlasBytes = Object.values(atlases).reduce((sum, item) => sum + item.width * item.height * 4, 0);
    const scratchBytes = Object.values(blends).length * FRAME_SIZE * FRAME_SIZE * 4
      + Object.keys(wisps).length * 32 * 32 * 4 + (scar ? WORLD_SIZE * WORLD_SIZE * 4 : 0)
      + (worldLayer ? WORLD_SIZE * WORLD_SIZE * 4 : 0) + (granulation ? granulation.byteLength : 0);
    return { ready: prepared, assetsLoaded: [...loaded], failures: [...failures], atlasReady,
      atlasFrames, atlasFrameSize: FRAME_SIZE, atlasFramesPerStar: FRAME_COUNT, atlasLoopSeconds: LOOP_SECONDS,
      atlasProgress: atlasFrames / (FRAME_COUNT * Object.keys(STAR).length), preparationMs: Math.round(preparationMs),
      decodedBytes, atlasBytes, scratchBytes, estimatedBytes: decodedBytes + atlasBytes + scratchBytes };
  }

  const ready = Promise.all(ASSETS.map(load)).then(async () => {
    const start = performance.now();
    try { prepareScar(); prepareWisps(); if (prepareMap()) await bakeAtlases(); }
    catch (error) { failures.push('preparation: ' + error.message); }
    preparationMs = performance.now() - start; prepared = true;
    return status();
  });
  window.BodyRenderer = { ready, drawStar, drawWorld, status };
})();
