/* BodyRenderer: optional Canvas 2D body art, with no simulation state or clock.
 * Both draw methods return false while the required sprite is unavailable, so
 * the caller can keep its existing colored circle. All ctx state is restored.
 * Surface maps are projected onto a sphere once, in short idle batches. Drawing
 * blends cached frames; it never reads pixels or advances an independent clock.
 * World detail is an overlay: the caller draws its climate-colored disc first.
 */
(() => {
  'use strict';
  const scriptURL = document.currentScript && document.currentScript.src;
  const assetRoot = new URL('../assets/bodies/', scriptURL || new URL('src/body-renderer.js', location.href));
  const TAU = Math.PI * 2;
  const FRAME_SIZE = 64, FRAME_COUNT = 64, ATLAS_COLUMNS = 8;
  const MAP_WIDTH = 256, MAP_HEIGHT = 128, WORLD_SIZE = 128, MOTION_STRENGTH = .55;
  const PERIODS = { planet: 24, moon: 56, amber: 48, cyan: 56, coral: 64 };
  const STAR = {
    amber: { rgb: [255, 203, 82], phase: .25 },
    cyan: { rgb: [143, 220, 255], phase: 2.30 },
    coral: { rgb: [255, 138, 107], phase: 4.65 }
  };
  const CLIMATES = ['planet-frozen', 'planet-thawing', 'planet-temperate', 'planet-warming', 'planet-hot'];
  const ASSETS = ['star-amber', 'star-cyan', 'star-coral', ...CLIMATES, 'moon', 'planet-stripped',
    'planet-surface', 'moon-surface', 'star-surface'];
  const images = Object.create(null), atlases = Object.create(null), blends = Object.create(null), wisps = Object.create(null);
  const failures = [], loaded = new Set(), rotationReady = { planet: false, moon: false, star: false };
  const recentPhases = Object.create(null);
  let atlasFrames = 0, atlasReady = false, prepared = false, preparationMs = 0;
  let scar = null, worldLayer = null, worldLayerKey = '', atlasJobs = 0;

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

  function readMap(image, grayscale = false) {
    const target = canvas(MAP_WIDTH, MAP_HEIGHT), context = target.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, MAP_WIDTH, MAP_HEIGHT);
    const pixels = context.getImageData(0, 0, MAP_WIDTH, MAP_HEIGHT).data;
    // Meet both longitude edges at their mean. The short transition keeps an
    // imperfect source seam from becoming a visible line during a full turn.
    const seam = 12;
    for (let y = 0; y < MAP_HEIGHT; y++) for (let x = 0; x < seam; x++) {
      const a = (y * MAP_WIDTH + x) * 4, b = (y * MAP_WIDTH + MAP_WIDTH - 1 - x) * 4;
      const weight = 1 - smooth(x / (seam - 1));
      for (let c = 0; c < 3; c++) {
        const mean = (pixels[a + c] + pixels[b + c]) * .5;
        pixels[a + c] += (mean - pixels[a + c]) * weight;
        pixels[b + c] += (mean - pixels[b + c]) * weight;
      }
    }
    const poles = [0, 0];
    for (let end = 0; end < 2; end++) for (let x = 0; x < MAP_WIDTH; x++) {
      const p = ((end ? MAP_HEIGHT - 1 : 0) * MAP_WIDTH + x) * 4;
      poles[end] += (pixels[p] * .2126 + pixels[p + 1] * .7152 + pixels[p + 2] * .0722) / MAP_WIDTH;
    }
    let mean = 0, variance = 0;
    if (grayscale) {
      for (let p = 0; p < pixels.length; p += 4) mean += pixels[p] * .2126 + pixels[p + 1] * .7152 + pixels[p + 2] * .0722;
      mean /= MAP_WIDTH * MAP_HEIGHT;
      for (let p = 0; p < pixels.length; p += 4) variance += (pixels[p] * .2126 + pixels[p + 1] * .7152 + pixels[p + 2] * .0722 - mean) ** 2;
    }
    return { pixels, poles, mean, gain: grayscale ? 34 / Math.max(8, Math.sqrt(variance / (MAP_WIDTH * MAP_HEIGHT))) : 1 };
  }

  function sampleMap(map, u, v, result) {
    const xx = ((u % 1) + 1) % 1 * MAP_WIDTH, yy = clamp(v, 0, 1) * (MAP_HEIGHT - 1);
    const x0 = Math.floor(xx), x1 = (x0 + 1) % MAP_WIDTH, y0 = Math.floor(yy), y1 = Math.min(MAP_HEIGHT - 1, y0 + 1);
    const fx = xx - x0, fy = yy - y0, pixels = map.pixels;
    const pole = smooth((Math.abs(v - .5) - .42) / .08), poleValue = map.poles[v < .5 ? 0 : 1];
    for (let c = 0; c < 3; c++) {
      const top = pixels[(y0 * MAP_WIDTH + x0) * 4 + c] * (1 - fx) + pixels[(y0 * MAP_WIDTH + x1) * 4 + c] * fx;
      const bottom = pixels[(y1 * MAP_WIDTH + x0) * 4 + c] * (1 - fx) + pixels[(y1 * MAP_WIDTH + x1) * 4 + c] * fx;
      result[c] = (top * (1 - fy) + bottom * fy) * (1 - pole) + poleValue * pole;
    }
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

  const PALETTES = [
    [[178, 211, 220], [94, 134, 151], [226, 237, 237]],
    [[62, 125, 140], [141, 173, 154], [213, 229, 220]],
    [[33, 92, 110], [163, 180, 147], [221, 230, 218]],
    [[79, 111, 104], [165, 148, 108], [226, 221, 194]],
    [[204, 136, 80], [104, 79, 63], [232, 189, 144]]
  ];

  function createAtlasBuilder(maps) {
    const target = canvas(FRAME_SIZE, FRAME_SIZE), context = target.getContext('2d');
    const pixels = context.createImageData(FRAME_SIZE, FRAME_SIZE), surface = new Float32Array(3);
    const geometry = [], tilt = 14 * Math.PI / 180;
    for (let y = 0; y < FRAME_SIZE; y++) for (let x = 0; x < FRAME_SIZE; x++) {
      const nx = (x + .5) / FRAME_SIZE * 2 - 1, ny = (y + .5) / FRAME_SIZE * 2 - 1, r2 = nx * nx + ny * ny;
      if (r2 >= 1) continue;
      const z = Math.sqrt(1 - r2), sx = nx * Math.cos(tilt) + ny * Math.sin(tilt), sy = -nx * Math.sin(tilt) + ny * Math.cos(tilt);
      geometry.push({ p: (y * FRAME_SIZE + x) * 4, u: .5 + Math.atan2(sx, z) / TAU,
        v: .5 + Math.asin(clamp(sy, -1, 1)) / Math.PI, alpha: smooth((1 - Math.sqrt(r2)) / .035), z, nx, ny });
    }
    return (name, frame) => {
      pixels.data.fill(0);
      const phase = frame / FRAME_COUNT, star = name === 'star', moon = name === 'moon', scarred = name === 'scar';
      const map = maps[star ? 'star' : moon ? 'moon' : 'planet'];
      const palette = !star && !moon && !scarred ? PALETTES[Number(name.slice(-1))] : null;
      let starMean = 0, starWeight = 0;
      for (const g of geometry) {
        const u = ((g.u + phase) % 1 + 1) % 1, p = g.p;
        if (scarred) {
          // A surface-space fracture shares the exact geography, projection,
          // and phase of every climate frame. It rolls behind the limb too.
          const du = ((u - .66 + 1.5) % 1) - .5, dv = g.v - .35;
          const crack = du - .013 * Math.sin(dv * 55) - .007 * Math.sin(dv * 112);
          const extent = smooth((dv + .14) / .035) * smooth((.18 - dv) / .05);
          const rough = Math.exp(-(du * du / .003 + dv * dv / .014)) * .14;
          pixels.data[p] = 13; pixels.data[p + 1] = 22; pixels.data[p + 2] = 25;
          pixels.data[p + 3] = Math.round((Math.exp(-((crack / .010) ** 2)) * .38 * extent + rough) * g.alpha * 255);
          continue;
        }
        sampleMap(map, u, g.v, surface);
        const luma = surface[0] * .2126 + surface[1] * .7152 + surface[2] * .0722;
        if (star) {
          // Small periodic convection travels with the surface; the projected
          // features themselves perform a true full longitudinal rotation.
          const activity = 5 * Math.sin(TAU * (phase * 2 + u * 3)) * Math.cos(g.v * 19 - phase * TAU);
          const value = clamp(212 + (luma - map.mean) * map.gain + activity, 116, 255) * (.70 + .30 * Math.sqrt(g.z));
          pixels.data[p] = pixels.data[p + 1] = pixels.data[p + 2] = value;
          starMean += value * g.alpha; starWeight += g.alpha;
        } else if (moon) {
          const value = clamp(102 + (luma - 110) * .78, 55, 200) * (.72 + .28 * g.z);
          pixels.data[p] = value * 1.03; pixels.data[p + 1] = value * 1.015; pixels.data[p + 2] = value;
        } else {
          const land = smooth((surface[0] - surface[2] + 60) / 45);
          const cloud = smooth((luma - 147) / 72) * (1 - clamp((Math.max(...surface) - Math.min(...surface) - 40) / 70, 0, 1));
          const detail = clamp(.79 + luma / 470, .80, 1.17), shade = .73 + .27 * g.z;
          for (let c = 0; c < 3; c++) {
            const ground = palette[0][c] * (1 - land) + palette[1][c] * land;
            pixels.data[p + c] = (ground * detail * (1 - cloud) + palette[2][c] * cloud) * shade;
          }
        }
        pixels.data[p + 3] = Math.round(g.alpha * 255);
      }
      if (star) {
        // Keep the disc's total light stable across the loop. Granulation is
        // visual texture; it must not impersonate changes in stellar output.
        const offset = 209 - starMean / starWeight;
        for (const g of geometry) for (let c = 0; c < 3; c++) pixels.data[g.p + c] = clamp(pixels.data[g.p + c] + offset, 0, 255);
      }
      context.putImageData(pixels, 0, 0);
      const atlas = atlases[name], out = atlas.getContext('2d');
      out.drawImage(target, frame % ATLAS_COLUMNS * FRAME_SIZE, Math.floor(frame / ATLAS_COLUMNS) * FRAME_SIZE);
      atlasFrames++;
    };
  }

  function bakeAtlases() {
    const maps = Object.create(null), jobs = [], names = [];
    for (const type of ['planet', 'moon', 'star']) {
      if (!images[type + '-surface']) continue;
      try { maps[type] = readMap(images[type + '-surface'], type === 'star'); }
      catch (error) { failures.push(type + ' surface: ' + error.message); }
    }
    if (maps.star) names.push('star');
    if (maps.moon) names.push('moon');
    if (maps.planet) names.push('climate0', 'climate1', 'climate2', 'climate3', 'climate4', 'scar');
    for (const name of names) {
      atlases[name] = canvas(ATLAS_COLUMNS * FRAME_SIZE, FRAME_COUNT / ATLAS_COLUMNS * FRAME_SIZE);
      for (let frame = 0; frame < FRAME_COUNT; frame++) jobs.push([name, frame]);
    }
    atlasJobs = jobs.length;
    if (!jobs.length) return Promise.resolve();
    const bake = createAtlasBuilder(maps);
    return new Promise(resolve => {
      // Start after the first paint. Continue in small frame-aligned slices:
      // repeated idle callbacks can wait 50ms each even on an idle desktop.
      const queue = (callback, initial = false) => {
        if (initial && typeof window.requestIdleCallback === 'function')
          return window.requestIdleCallback(callback, { timeout: 150 });
        const next = () => callback({ timeRemaining: () => Infinity });
        return typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame(next) : window.setTimeout(next, 0);
      };
      let index = 0;
      const step = deadline => {
        try {
          let count = 0; const started = performance.now();
          do {
            const [name, frame] = jobs[index++]; bake(name, frame); count++;
            if (frame === FRAME_COUNT - 1) {
              if (name === 'scar') rotationReady.planet = true;
              if (name === 'moon') rotationReady.moon = true;
              if (name === 'star') rotationReady.star = true;
            }
          } while (index < jobs.length && count < 32 && performance.now() - started < 5 && deadline.timeRemaining() > 3);
          if (index < jobs.length) queue(step); else { atlasReady = true; resolve(); }
        } catch (error) { failures.push('atlas: ' + error.message); resolve(); }
      };
      queue(step, true);
    });
  }

  function atlasFrame(context, atlas, frame, x, y, size) {
    context.drawImage(atlas, frame % ATLAS_COLUMNS * FRAME_SIZE, Math.floor(frame / ATLAS_COLUMNS) * FRAME_SIZE,
      FRAME_SIZE, FRAME_SIZE, x, y, size, size);
  }

  function rotationPhase(spec, type) {
    const id = String(spec.bodyId ?? (type === 'planet' || type === 'moon' ? type : spec.id));
    let hash = 2166136261;
    for (let i = 0; i < id.length; i++) { hash ^= id.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    const offset = (hash >>> 0) / 4294967296 + (STAR[type] ? STAR[type].phase / TAU : 0);
    const quality = clamp(Math.floor(finite(spec.quality, 0)), 0, 2), fps = [30, 20, 12][quality];
    const seconds = spec.reducedMotion ? 0 : Math.floor(finite(spec.spinTime, 0) * fps) / fps;
    const phase = ((seconds / PERIODS[type] + offset) % 1 + 1) % 1;
    recentPhases[type + ':' + id] = phase;
    // Diagnostic history stays bounded even if the user creates many bodies.
    if (Object.keys(recentPhases).length > 24) delete recentPhases[Object.keys(recentPhases)[0]];
    return phase;
  }

  function layer(key) {
    if (!blends[key]) {
      // Runtime scratch surfaces are bounded independently of body IDs.
      if (Object.keys(blends).length >= 16) delete blends[Object.keys(blends)[0]];
      const target = canvas(FRAME_SIZE, FRAME_SIZE);
      blends[key] = { canvas: target, context: target.getContext('2d'), key: '' };
    }
    return blends[key];
  }

  function drawWeightedFrames(g, name, phase, weight, clear) {
    if (!weight) return;
    const position = phase * FRAME_COUNT, first = Math.floor(position) % FRAME_COUNT, mix = position - Math.floor(position);
    g.globalCompositeOperation = clear ? 'source-over' : 'lighter'; g.globalAlpha = weight * (1 - mix);
    atlasFrame(g, atlases[name], first, 0, 0, FRAME_SIZE);
    if (mix > 0) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = weight * mix; atlasFrame(g, atlases[name], (first + 1) % FRAME_COUNT, 0, 0, FRAME_SIZE); }
  }

  function starSurface(spec) {
    if (!rotationReady.star) return images['star-' + spec.id];
    const phase = rotationPhase(spec, spec.id), cache = layer('star:' + spec.id), key = String(phase);
    if (cache.key === key) return cache.canvas;
    cache.key = key;
    const g = cache.context; g.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);
    drawWeightedFrames(g, 'star', phase, 1, true);
    g.globalAlpha = 1; g.globalCompositeOperation = 'multiply';
    // Tint within the sphere only; source-atop restores its antialiased edge.
    g.save(); g.beginPath(); g.arc(FRAME_SIZE / 2, FRAME_SIZE / 2, FRAME_SIZE / 2 - .1, 0, TAU); g.clip();
    g.fillStyle = rgba(STAR[spec.id].rgb.map(value => Math.round(90 + value * .647)), 1); g.fillRect(0, 0, FRAME_SIZE, FRAME_SIZE);
    g.restore();
    g.globalCompositeOperation = 'destination-in';
    const mask = layer('star-mask');
    if (mask.key !== key) { mask.context.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE); drawWeightedFrames(mask.context, 'star', phase, 1, true); mask.key = key; }
    g.drawImage(mask.canvas, 0, 0); g.globalCompositeOperation = 'source-over';
    return cache.canvas;
  }

  function drawStar(ctx, spec) {
    if (!ctx || !hasPosition(spec) || !STAR[spec.id] || (!rotationReady.star && !images['star-' + spec.id])) return false;
    const alpha = opacity(spec.alpha); if (!alpha) return true;
    const quality = clamp(Math.floor(finite(spec.quality, 0)), 0, 2), time = spec.reducedMotion ? 0 : finite(spec.time, 0);
    const source = starSurface(spec), { x, y, r } = spec;
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

  function staticWorldSurface(climate, moon, ripped) {
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

  function worldSurface(spec) {
    const moon = !!spec.moon, type = moon ? 'moon' : 'planet';
    if (!rotationReady[type]) return staticWorldSurface(spec.climate, moon, !!spec.ripped);
    const phase = rotationPhase(spec, type), climate = clamp(finite(spec.climate, 2), 0, 4);
    const cache = layer(type + ':' + String(spec.bodyId ?? type));
    const key = phase + ':' + climate + ':' + !!spec.ripped;
    if (cache.key === key) return cache.canvas;
    cache.key = key;
    const g = cache.context; g.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);
    if (moon) drawWeightedFrames(g, 'moon', phase, 1, true);
    else {
      const low = Math.floor(climate), high = Math.min(4, low + 1), mix = climate - low;
      // Four weighted samples blend both longitude and climate without changing
      // geography or darkening the shared antialiased silhouette.
      drawWeightedFrames(g, 'climate' + low, phase, 1 - mix, true);
      if (mix) drawWeightedFrames(g, 'climate' + high, phase, mix, false);
      if (spec.ripped) {
        const mark = layer('scar');
        if (mark.key !== String(phase)) {
          mark.context.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);
          drawWeightedFrames(mark.context, 'scar', phase, 1, true); mark.key = String(phase);
        }
        g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.drawImage(mark.canvas, 0, 0);
      }
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    return cache.canvas;
  }

  function drawWorld(ctx, spec) {
    if (!ctx || !hasPosition(spec)) return false;
    const source = worldSurface(spec);
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
      + (worldLayer ? WORLD_SIZE * WORLD_SIZE * 4 : 0);
    return { ready: prepared, assetsLoaded: [...loaded], failures: [...failures], atlasReady,
      atlasFrames, atlasFrameSize: FRAME_SIZE, atlasFramesPerRotation: FRAME_COUNT, atlasNames: Object.keys(atlases),
      rotationReady: { ...rotationReady }, rotationPeriods: { ...PERIODS }, recentPhases: { ...recentPhases },
      scratchLayers: Object.keys(blends).length,
      atlasProgress: atlasJobs ? atlasFrames / atlasJobs : 0, preparationMs: Math.round(preparationMs),
      decodedBytes, atlasBytes, scratchBytes, estimatedBytes: decodedBytes + atlasBytes + scratchBytes };
  }

  const ready = Promise.all(ASSETS.map(load)).then(async () => {
    const start = performance.now();
    try { prepareScar(); prepareWisps(); await bakeAtlases(); }
    catch (error) { failures.push('preparation: ' + error.message); }
    preparationMs = performance.now() - start; prepared = true;
    return status();
  });
  window.BodyRenderer = { ready, drawStar, drawWorld, status };
})();
