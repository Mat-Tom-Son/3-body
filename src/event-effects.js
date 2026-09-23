/* Local, body-attached presentation effects. No trajectories or physics state are created here. */
(function installEventEffects(global) {
  'use strict';

  const VERSION = '1.0.0';
  const STAR_MASS = 0.05; // Exact simulation classification; kind is only a fallback when mass is absent.
  const TAU = Math.PI * 2;
  const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
  const smooth = value => { value = clamp(value); return value * value * (3 - 2 * value); };
  const durationByMode = Object.freeze({ rip: 1.35, moon: 1.15, impact: 0.82, swallow: 0.68, stellar: 0.62 });
  const palettes = Object.freeze({
    dark: { material: '#91B9AE', cool: '#8FDCFF', warm: '#FFCB52', flash: '#EAF2FA', dust: '#B8AC99' },
    light: { material: '#356C5E', cool: '#1769A0', warm: '#966006', flash: '#BF6B25', dust: '#665546' }
  });
  const scriptURL = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : '';
  const defaultFragmentURL = scriptURL ? new URL('../assets/bodies/debris-fragment.webp', scriptURL).href : 'assets/bodies/debris-fragment.webp';
  const textures = new Map();

  function finite(value, fallback = 0) { return Number.isFinite(value) ? value : fallback; }
  function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function random(seed, i) {
    let n = (seed + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
    n ^= n >>> 16; n = Math.imul(n, 0x7feb352d); n ^= n >>> 15; n = Math.imul(n, 0x846ca68b);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }
  function list(value) { return Array.isArray(value) ? value : []; }
  function snapshot(body) {
    return body ? { id: body.id, x: finite(body.x), y: finite(body.y), vx: finite(body.vx), vy: finite(body.vy), m: finite(body.m), kind: body.kind || null } : null;
  }
  function isStar(body) {
    if (!body) return false;
    if (Number.isFinite(body.m)) return body.m >= STAR_MASS;
    return body.kind === 'star' || body.kind === 'sun';
  }
  function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${clamp(alpha)})`;
  }
  function alphaCrop(image) {
    // This only crops at draw time. It never alters the source asset.
    if (typeof document === 'undefined') return [0, 0, image.naturalWidth, image.naturalHeight];
    try {
      const canvas = document.createElement('canvas');
      const factor = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * factor));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * factor));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 64) {
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
      }
      if (right < left) return [0, 0, image.naturalWidth, image.naturalHeight];
      return [left / factor, top / factor, (right - left + 1) / factor, (bottom - top + 1) / factor];
    } catch (_) { return [0, 0, image.naturalWidth, image.naturalHeight]; }
  }
  function getTexture(url) {
    if (textures.has(url)) return textures.get(url);
    const record = { state: 'loading', image: null, crop: null };
    textures.set(url, record);
    if (typeof global.Image !== 'function') { record.state = 'unavailable'; return record; }
    const image = new global.Image();
    image.onload = () => { record.image = image; record.crop = alphaCrop(image); record.state = 'ready'; };
    image.onerror = () => { record.state = 'unavailable'; };
    image.src = url;
    return record;
  }
  function stroke(ctx, x1, y1, x2, y2, color, alpha, width = 0.7) {
    if (alpha <= 0) return;
    ctx.strokeStyle = rgba(color, alpha); ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  function point(ctx, x, y, radius, color, alpha) {
    if (alpha <= 0 || radius <= 0) return;
    ctx.fillStyle = rgba(color, alpha); ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill();
  }
  function glow(ctx, x, y, radius, color, alpha) {
    if (alpha <= 0 || radius <= 0) return;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, rgba(color, alpha)); gradient.addColorStop(0.35, rgba(color, alpha * 0.32)); gradient.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = gradient; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  function arc(ctx, body, angle, color, alpha, offset = 0.8) {
    ctx.strokeStyle = rgba(color, alpha); ctx.lineWidth = 0.85;
    ctx.beginPath(); ctx.arc(body.x, body.y, body.r + offset, angle - 0.24, angle + 0.24); ctx.stroke();
  }

  /**
   * add(event, {before, after}): rip {id,by}, moon {id,from}, merge {a,b,into,gone}.
   * add returns {id,type,mode,ownerId,partnerId}, or false for ignored events.
   * before/after are actual body snapshots. Merge snapshots should be captured at contact.
   * update(dt, {playing,reducedMotion}): dt is real visual seconds, not simulation years.
   * draw(ctx, {bodies,project,radius,quality,theme}): coordinates/radii are canvas CSS pixels.
   * Call draw after current bodies; this manager draws no persistent or replacement bodies.
   */
  function create({ maxEffects = 12, fragmentURL = defaultFragmentURL } = {}) {
    const limit = clamp(Math.floor(finite(maxEffects, 12)), 1, 32);
    const texture = getTexture(fragmentURL);
    let effects = [], sequence = 0, playing = true, reducedMotion = false, lastAdded = null;
    const seen = new Set();
    const metrics = { added: 0, duplicate: 0, rejected: 0, expired: 0, detached: 0, overflow: 0, resets: 0, drawn: 0, particles: 0, quality: 0 };

    function add(event, context = {}) {
      if (!event || !['rip', 'moon', 'merge'].includes(event.type)) { metrics.rejected++; return false; }
      const ownerId = event.type === 'merge' ? event.into : event.id;
      const partnerId = event.type === 'rip' ? event.by : event.type === 'moon' ? event.from : event.gone;
      if (ownerId === undefined || ownerId === null || ((event.type === 'rip' || event.type === 'moon') && (partnerId === undefined || partnerId === null))) { metrics.rejected++; return false; }
      const key = `${event.type}:${event.t}:${ownerId}:${partnerId}:${event.a}:${event.b}`;
      if (Number.isFinite(event.t) && seen.has(key)) { metrics.duplicate++; return false; }
      const before = list(context.before || event.before), after = list(context.after || event.after);
      const beforeOwner = snapshot(before.find(body => body.id === ownerId));
      const beforeOther = snapshot(before.find(body => body.id === partnerId));
      const afterOwner = snapshot(after.find(body => body.id === ownerId));
      let mode = event.type;
      if (event.type === 'merge') {
        const a = before.find(body => body.id === event.a), b = before.find(body => body.id === event.b);
        if (a && b) mode = isStar(a) && isStar(b) ? 'stellar' : isStar(a) || isStar(b) ? 'swallow' : 'impact';
        else if (event.star === true) mode = 'swallow';
        else mode = isStar(beforeOwner || afterOwner) || finite(event.m) >= STAR_MASS ? 'stellar' : 'impact';
      }
      let dx = beforeOther && beforeOwner ? beforeOther.x - beforeOwner.x : 0;
      let dy = beforeOther && beforeOwner ? beforeOther.y - beforeOwner.y : 0;
      if (Math.hypot(dx, dy) < 1e-14 && beforeOther && beforeOwner) {
        dx = beforeOwner.vx - beforeOther.vx; dy = beforeOwner.vy - beforeOther.vy;
      }
      const effect = { id: ++sequence, type: event.type, mode, ownerId, partnerId, age: 0, duration: durationByMode[mode], seed: hash(key), dx, dy };
      if (effects.length >= limit) { effects.shift(); metrics.overflow++; }
      effects.push(effect); metrics.added++;
      if (Number.isFinite(event.t)) { seen.add(key); if (seen.size > 128) seen.delete(seen.values().next().value); }
      lastAdded = { id: effect.id, type: effect.type, mode, ownerId, partnerId };
      return { ...lastAdded };
    }

    function update(dt, options = {}) {
      if (typeof options.playing === 'boolean') playing = options.playing;
      if (typeof options.reducedMotion === 'boolean') reducedMotion = options.reducedMotion;
      if (!playing) return;
      const elapsed = Math.max(0, finite(dt));
      effects = effects.filter(effect => {
        effect.age += elapsed;
        if (effect.age >= (reducedMotion ? 0.26 : effect.duration)) { metrics.expired++; return false; }
        return true;
      });
    }

    function draw(ctx, { bodies = [], project, radius, quality = 0, theme = 'dark' } = {}) {
      metrics.drawn = 0; metrics.particles = 0; metrics.quality = clamp(Math.floor(finite(quality)), 0, 2);
      if (!ctx || typeof project !== 'function' || typeof radius !== 'function' || !effects.length) return;
      const bodyMap = new Map(list(bodies).map(body => [body.id, body]));
      const screenCache = new Map();
      const light = theme === 'light' || (theme && (theme.mode === 'light' || theme.dark === false));
      const color = light ? palettes.light : palettes.dark;
      const count = normal => reducedMotion || metrics.quality === 2 ? 0 : metrics.quality === 1 ? Math.ceil(normal * 0.45) : normal;
      function screen(id) {
        if (screenCache.has(id)) return screenCache.get(id);
        const body = bodyMap.get(id);
        if (!body) return null;
        const p = project(body), r = radius(body);
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(r) || r <= 0) return null;
        const value = { x: p.x, y: p.y, r: clamp(r, 0.5, 160), body };
        screenCache.set(id, value); return value;
      }
      function direction(effect, owner, other) {
        let dx = 0, dy = 0;
        if (other) { dx = other.x - owner.x; dy = other.y - owner.y; }
        else if (effect.dx || effect.dy) {
          const worldLength = Math.hypot(effect.dx, effect.dy);
          // Project a direction at the current owner. It is not a second body's position.
          const endpoint = project({ ...owner.body, x: owner.body.x + effect.dx / worldLength, y: owner.body.y + effect.dy / worldLength });
          if (endpoint) { dx = endpoint.x - owner.x; dy = endpoint.y - owner.y; }
        }
        const length = Math.hypot(dx, dy);
        if (length > 1e-8) return { x: dx / length, y: dy / length, angle: Math.atan2(dy, dx), distance: length };
        const angle = random(effect.seed, 99) * TAU;
        return { x: Math.cos(angle), y: Math.sin(angle), angle, distance: 0 };
      }
      function particle(x, y, size, angle, alpha) {
        if (alpha <= 0.015) return;
        metrics.particles++;
        if (texture.state === 'ready') {
          ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.globalAlpha *= clamp(alpha);
          const [sx, sy, sw, sh] = texture.crop;
          const max = Math.max(sw, sh), w = size * sw / max, h = size * sh / max;
          ctx.drawImage(texture.image, sx, sy, sw, sh, -w / 2, -h / 2, w, h); ctx.restore();
        } else {
          ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.fillStyle = rgba(color.material, alpha);
          ctx.beginPath(); ctx.moveTo(-size * 0.5, -size * 0.17); ctx.lineTo(size * 0.13, -size * 0.42); ctx.lineTo(size * 0.48, size * 0.12); ctx.lineTo(-size * 0.13, size * 0.42); ctx.closePath(); ctx.fill(); ctx.restore();
        }
      }

      ctx.save();
      ctx.globalCompositeOperation = 'source-over'; ctx.lineCap = 'round';
      effects = effects.filter(effect => {
        const owner = screen(effect.ownerId);
        const other = effect.type === 'rip' || effect.type === 'moon' ? screen(effect.partnerId) : null;
        if (!owner || ((effect.type === 'rip' || effect.type === 'moon') && !other)) { metrics.detached++; return false; }
        metrics.drawn++;
        const d = direction(effect, owner, other), p = clamp(effect.age / effect.duration), bodySize = Math.min(owner.r, 24);
        const fade = 1 - smooth((p - 0.66) / 0.34), cx = owner.x + d.x * owner.r * 0.88, cy = owner.y + d.y * owner.r * 0.88;
        if (reducedMotion || metrics.quality === 2) {
          arc(ctx, owner, d.angle, effect.mode === 'rip' || effect.mode === 'moon' ? color.cool : color.warm, reducedMotion ? 0.48 : 0.35 * fade);
          return true;
        }
        if (effect.mode === 'rip') {
          const reach = Math.min(42, bodySize * 3 + 10, Math.max(0, d.distance - owner.r - other.r));
          const n = count(12);
          for (let i = 0; i < n; i++) {
            const r = random(effect.seed, i), q = clamp((p - i / Math.max(n - 1, 1) * 0.22) / 0.64);
            const travel = smooth(q), side = (r - 0.5) * Math.min(5, bodySize * 0.65) * Math.sin(travel * Math.PI);
            const distance = owner.r + 0.8 + travel * reach;
            particle(owner.x + d.x * distance - d.y * side, owner.y + d.y * distance + d.x * side, 0.9 + r * 0.65, r * TAU + p, smooth(q / 0.12) * fade * 0.76);
          }
          arc(ctx, owner, d.angle, color.cool, Math.sin(p * Math.PI) * 0.15);
        } else if (effect.mode === 'moon') {
          const n = count(12), span = Math.min(36, Math.max(4, d.distance - owner.r - other.r));
          for (let i = 0; i < n; i++) {
            const r = random(effect.seed, i), q = smooth(clamp((p - (i % 3) * 0.025) / 0.88));
            const distance = (owner.r + span * (0.28 + r * 0.72)) * (1 - q);
            const side = (random(effect.seed, i + 30) - 0.5) * Math.min(14, span * 0.7) * (1 - q);
            particle(owner.x + d.x * distance - d.y * side, owner.y + d.y * distance + d.x * side, 0.95 + r * 0.55, r * TAU + q, (1 - smooth((q - 0.68) / 0.3)) * 0.78);
          }
          arc(ctx, owner, d.angle, color.cool, Math.sin(p * Math.PI) * 0.16);
        } else if (effect.mode === 'impact') {
          const flash = Math.max(0, 1 - effect.age / 0.13);
          glow(ctx, cx, cy, clamp(bodySize * 1.1, 4, 11), color.warm, flash * 0.28);
          point(ctx, cx, cy, clamp(bodySize * 0.22, 0.8, 2.1), color.flash, flash * 0.72);
          const n = count(10);
          for (let i = 0; i < n; i++) {
            const r = random(effect.seed, i), angle = d.angle + (r - 0.5) * 1.3, lift = Math.sin(clamp(p / 0.85) * Math.PI);
            const distance = 1 + lift * Math.min(11, bodySize * (0.7 + r * 0.65));
            particle(cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance, 0.7 + r * 0.65, angle + p, (1 - smooth((p - 0.2) / 0.7)) * 0.55);
          }
          arc(ctx, owner, d.angle, color.dust, 0.25 * fade, -0.7);
        } else if (effect.mode === 'swallow') {
          const flash = Math.sin(Math.PI * clamp(p / 0.7));
          glow(ctx, cx, cy, clamp(bodySize * 0.75, 4, 15), color.warm, flash * 0.2);
          const n = count(5);
          // A few short material filaments end at the current stellar limb; no gone body is redrawn.
          for (let i = 0; i < n; i++) {
            const r = random(effect.seed, i), side = (r - 0.5) * bodySize * 0.35, reach = (1 - smooth(p / 0.62)) * Math.min(14, bodySize * 0.8 + 3);
            stroke(ctx, cx + d.x * reach - d.y * side, cy + d.y * reach + d.x * side, cx - d.y * side * 0.4, cy + d.x * side * 0.4, color.warm, flash * 0.3, 0.5 + r * 0.5);
          }
          point(ctx, cx, cy, clamp(bodySize * 0.1, 0.7, 1.7), color.flash, flash * 0.45);
        } else {
          const flash = Math.max(0, 1 - p / 0.65);
          glow(ctx, cx, cy, clamp(bodySize * 0.8, 5, 17), color.warm, flash * 0.22);
          arc(ctx, owner, d.angle, color.warm, flash * 0.5);
          point(ctx, cx, cy, clamp(bodySize * 0.13, 0.8, 2), color.flash, flash * 0.55);
        }
        return true;
      });
      ctx.restore();
    }

    function reset() { effects = []; seen.clear(); sequence = 0; lastAdded = null; metrics.resets++; metrics.drawn = 0; metrics.particles = 0; }
    function diagnostics() { return { ...metrics, active: effects.length, maxEffects: limit, playing, reducedMotion, texture: texture.state, lastAdded: lastAdded ? { ...lastAdded } : null }; }
    const api = { add, update, draw, reset, getDiagnostics: diagnostics };
    Object.defineProperties(api, {
      state: { enumerable: true, get: () => ({ playing, reducedMotion, effects: effects.map(effect => ({ id: effect.id, type: effect.type, mode: effect.mode, ownerId: effect.ownerId, partnerId: effect.partnerId, elapsed: effect.age, duration: effect.duration })) }) },
      diagnostics: { enumerable: true, get: diagnostics }
    });
    return api;
  }

  global.EventEffects = Object.freeze({ version: VERSION, create });
})(typeof window !== 'undefined' ? window : globalThis);
