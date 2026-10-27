/* The 3D view of the flat page: the same bodies, trails, sizes and colours, drawn with three.js as lit, textured spheres
 * over the orbital plane. The page owns the simulation, the trails, the climate and every control; this module only
 * projects, frames and draws. Loaded on demand, so the flat page never pays for it. */
import * as THREE from 'three';
import { LineSegments2 } from '../vendor/LineSegments2.js';
import { LineSegmentsGeometry } from '../vendor/LineSegmentsGeometry.js';
import { LineMaterial } from '../vendor/LineMaterial.js';
import { CameraRig, cameraOffset, climateTint, atmosphereTint, spinAngle, SPIN_PERIODS, STAR_PHASE, toneOf, clamp, TAU } from './sky3d-model.js';
import { createSurfaceView } from './sky3d-surface.js';
import { DEG, LATITUDE, R_EARTH_AU, localFrame, toLocal, altAz, starRadiusAU, worldRadiusAU, angularRadius, sunDaylight, skyDaylight, standingLongitude, spinFrame, solarDay, SkyLook, phoneLook } from './surface-model.js';

const FOV = 42, GLOW_SCALE = 7.5, SEG_CAP = 2200, LINE_PX = 1.8;
const LUM = b => (b.meta && b.meta.lum != null ? b.meta.lum : Math.pow(b.m, 3.5));   // a published brightness when the body carries one
/* a sphere needs a little more than a disc to read at a few pixels across; the same for every kind, so sizes keep the
 * proportions the page gives them */
const SIZE_GAIN = { star: 1.15, planet: 1.15, moon: 1.15, giant: 1.15 };
const assetRoot = new URL('../assets/bodies/', import.meta.url);

export function createSky3D({ canvas, onContextLost, onContextRestored, onTextureError }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  /* Only the lit worlds are tone mapped (every other material opts out), so a world close to a bright sun rolls off
   * gently instead of clipping to a flat disc, while suns, glows and trails keep the flat page's colours. */
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1;
  const lost = e => { e.preventDefault(); if (onContextLost) onContextLost(); };
  const restored = () => { invalidate(); if (onContextRestored) onContextRestored(); };
  canvas.addEventListener('webglcontextlost', lost); canvas.addEventListener('webglcontextrestored', restored);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 6000);
  const rig = new CameraRig();
  const view = { w: 1, h: 1, dpr: 1, cx: 0, cy: 0, quality: 0 };
  const tanFull = Math.tan(FOV * Math.PI / 360);
  let pxPerWorld = 100, themeStamp = 0, additive = true;
  const theme = { ink: [234, 242, 250], field: [8, 23, 41], moon: [174, 185, 198] };
  /* The page gives sRGB bytes; three.js works in linear light, so every colour is converted on the way in. */
  const toColor = rgb => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);

  /* ---------------------------------------------------------------- fixed scenery */
  const ambient = new THREE.AmbientLight(0x8fa0cc, 0.3); scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0x3a4f80, 0x05070c, 0.18); scene.add(hemi);
  const starfield = (() => {
    const n = 2200, p = new Float32Array(3 * n), sz = new Float32Array(n);
    let seed = 7; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < n; i++) {
      const z = 2 * rnd() - 1, a = TAU * rnd(), r = Math.sqrt(1 - z * z) * 2600;
      p[3 * i] = r * Math.cos(a); p[3 * i + 1] = 2600 * z; p[3 * i + 2] = r * Math.sin(a); sz[i] = rnd();
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const m = new THREE.PointsMaterial({ color: 0xaab6d8, size: 1.7, sizeAttenuation: false, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false });
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; return pts;
  })();
  scene.add(starfield);
  /* One point light per sun, from a pool that only ever grows: three.js compiles its lit shaders for a number of lights,
   * so a merger, a swallowed sun or a setup with fewer suns must not change that number. Spare lights stay dark. */
  const lights = [];
  const ensureLights = n => { while (lights.length < n) { const l = new THREE.PointLight(0xffffff, 0, 0, 2); scene.add(l); lights.push(l); } };
  ensureLights(3);

  /* ---------------------------------------------------------------- textures, geometry, shaders */
  const imageLoader = new THREE.ImageLoader();
  /* A map that fails to load becomes plain mid-grey, so a world is drawn in its climate colour rather than black. */
  const plain = () => { const c = document.createElement('canvas'); c.width = c.height = 2; const k = c.getContext('2d'); k.fillStyle = '#9a9a9a'; k.fillRect(0, 0, 2, 2); return c; };
  /* A map shows a plain mid-grey until its image arrives, never the black of an empty texture: a red dwarf seen for the
   * first time is a plain disc for a moment, not a hole. Glow masks are data, not colour. */
  const placeholder = (() => { const c = document.createElement('canvas'); c.width = c.height = 2; const k = c.getContext('2d'); k.fillStyle = '#959595'; k.fillRect(0, 0, 2, 2); return c; })();
  const texture = name => {
    const t = new THREE.Texture(placeholder); t.needsUpdate = true;
    t.colorSpace = name.endsWith('-glow') ? THREE.NoColorSpace : THREE.SRGBColorSpace; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    /* the GPU storage was sized for the placeholder: release it so the real image gets storage of its own size */
    imageLoader.load(new URL(`${name}.webp`, assetRoot).href, img => { t.dispose(); t.image = img; t.needsUpdate = true; invalidate(); },
      undefined, () => { if (onTextureError) onTextureError(name); });
    return t;
  };
  /* Surface maps load on first use, so a system pays only for the maps its bodies wear. */
  const mapCache = new Map(), mapNamed = name => { let t = mapCache.get(name); if (!t) { t = texture(name); mapCache.set(name, t); } return t; };
  const maps = { star: mapNamed('star-surface'), planet: mapNamed('planet-surface'), moon: mapNamed('moon-surface') };
  /* the other body maps follow when the browser is idle, so the next system is usually ready before it is chosen */
  const later = window.requestIdleCallback || (f => setTimeout(f, 1500));
  later(() => ['v5/star-m-dwarf', 'v5/star-k-dwarf', 'v5/planet-eyeball', 'v5/planet-barren', 'v5/planet-terran-b', 'v5/giant-jovian', 'v5/giant-neptunian', 'v5/moon-icy',
    'v5/planet-arid', 'v5/planet-ocean'].forEach(n => mapNamed(n)));
  /* Which surface a body wears is decided by src/surfaces.js, shared with the flat chart. */
  const surfaceOf = (b, flux) => window.Surfaces.surfaceOf(b, flux, worldRadiusAU(b) / R_EARTH_AU);
  const glowMap = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const k = c.getContext('2d'), g = k.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.2, 'rgba(255,255,255,0.4)'); g.addColorStop(0.55, 'rgba(255,255,255,0.08)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    k.fillStyle = g; k.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const sphere = new THREE.SphereGeometry(1, 64, 40), sphereLow = new THREE.SphereGeometry(1, 28, 18);
  let dirty = 0;
  const invalidate = () => { dirty = 2; };

  /* A lit surface whose colours can be washed toward ice or ember with one mix in the fragment shader. Sunlight arrives at
   * its real strength, which spans a thousandfold between a hot inner world and a cold giant; uExposure compresses that to
   * the 0.4 power of the light received, so every world shows a day side and a terminator, and a brighter sun still reads
   * as brighter. */
  function worldMaterial(map, roughness) {
    const material = new THREE.MeshStandardMaterial({ map, roughness, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.16 });   // the night side keeps a faint picture of itself
    const tint = { value: new THREE.Color(1, 1, 1) }, amount = { value: 0 }, exposure = { value: 1 };
    material.onBeforeCompile = shader => {
      shader.uniforms.uTint = tint; shader.uniforms.uTintAmount = amount; shader.uniforms.uExposure = exposure;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uTint;\nuniform float uTintAmount;\nuniform float uExposure;')
        /* The climate wash keeps the map's light and dark structure, so ice or ember still show the turning surface. */
        .replace('#include <map_fragment>', '#include <map_fragment>\n\tfloat mapLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, uTint * (0.35 + 1.3 * mapLum), uTintAmount);')
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n\treflectedLight.directDiffuse *= uExposure;\n\treflectedLight.directSpecular *= uExposure;');
    };
    material.customProgramCacheKey = () => 'sky3d-world';
    material.userData.tint = tint; material.userData.amount = amount; material.userData.exposure = exposure;
    return material;
  }
  /* A sun: its own light, granulation from the shared map, darker toward the limb as real stars are. */
  function starMaterial(color, surface) {
    const material = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveMap: surface ? mapNamed(surface.name) : maps.star, emissiveIntensity: 0.55, roughness: 1, metalness: 0, toneMapped: false });
    const mean = { value: surface ? surface.mean : 0.22 };
    material.onBeforeCompile = shader => {
      /* The granulation map is a low-contrast grey; stretch it around a centre (uMean) so the cells read as the sun
       * turns, then darken toward the limb. The Sun's map keeps the centre it was tuned with, and each other map a centre
       * the same distance below its own average, so every star is as bright and only its texture differs. */
      shader.uniforms.uMean = mean;
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uMean;').replace('#include <emissivemap_fragment>',
        '\tfloat grain = dot(texture2D(emissiveMap, vEmissiveMapUv).rgb, vec3(0.299, 0.587, 0.114));\n' +
        '\ttotalEmissiveRadiance *= mix(0.5, 1.35, clamp(0.5 + (grain - uMean) * 6.0, 0.0, 1.0));\n' +
        '\tfloat limb = pow(saturate(dot(normalize(normal), normalize(vViewPosition))), 0.55);\n\ttotalEmissiveRadiance *= 0.42 + 0.78 * limb;');
    };
    material.customProgramCacheKey = () => 'sky3d-star';
    return material;
  }
  /* A thin atmosphere: a fresnel rim on a slightly larger shell, brighter on the sunlit side. The position goes through
   * modelViewMatrix, which three.js composes on the CPU in double precision, so a world hundreds of AU from the origin
   * does not jitter at close range. Additive on the dark field (a glow adds light), blended normally on the light one. */
  function atmosphereMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0.45, 0.75, 1) }, uStrength: { value: 0.8 }, uLight: { value: new THREE.Vector3(1, 0, 0) }, uAdd: { value: additive ? 1 : 0 } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; varying vec3 vW;\nvoid main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vW = normalize(mat3(modelMatrix) * normal); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform vec3 uColor; uniform float uStrength; uniform vec3 uLight; uniform float uAdd; varying vec3 vN; varying vec3 vV; varying vec3 vW;\nvoid main() { float rim = pow(1.0 - clamp(dot(vN, vV), 0.0, 1.0), 2.6); float sun = 0.3 + 0.7 * clamp(dot(vW, uLight) * 0.8 + 0.35, 0.0, 1.0); float a = clamp(rim * sun * uStrength, 0.0, 1.0); gl_FragColor = vec4(uColor, uAdd > 0.5 ? a * a : a);\n#include <colorspace_fragment>\n}',
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.FrontSide, toneMapped: false,
    });
  }

  /* ---------------------------------------------------------------- the warm zone on the orbital plane */
  /* A disc on the plane that follows the camera's target; each fragment sums the light of every sun at its own point
   * of the plane and keeps the band the page calls warm, so two suns' zones merge and stretch exactly as on the chart. */
  const MAX_WARM = 6;
  const warmU = { uSun: { value: Array.from({ length: MAX_WARM }, () => new THREE.Vector3()) }, uN: { value: 0 }, uLo: { value: Math.log(0.52) }, uHi: { value: Math.log(1.34) },
    uColor: { value: new THREE.Color() }, uAlpha: { value: 0.16 } };
  const warm = new THREE.Mesh(new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: warmU, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vP; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vP = vec2(w.x, -w.z); gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `
      #define MAX_WARM ${MAX_WARM}
      uniform vec3 uSun[MAX_WARM]; uniform int uN; uniform float uLo; uniform float uHi; uniform vec3 uColor; uniform float uAlpha; varying vec2 vP;
      void main() {
        float F = 0.0;
        for (int i = 0; i < MAX_WARM; i++) { if (i >= uN) break; vec2 d = vP - uSun[i].xy; F += uSun[i].z / max(dot(d, d), 1e-12); }
        float lf = log(F), s = 0.16;
        float a = smoothstep(uLo - s, uLo + s, lf) * (1.0 - smoothstep(uHi - s, uHi + s, lf));
        if (a <= 0.002) discard;
        gl_FragColor = vec4(uColor, uAlpha * a);
        #include <colorspace_fragment>
      }`,
  }));
  warm.renderOrder = -2; warm.frustumCulled = false; warm.visible = false; scene.add(warm);
  function placeWarm(w) {
    warm.visible = !!(w && w.suns.length);
    if (!warm.visible) return;
    const n = Math.min(MAX_WARM, w.suns.length);
    for (let i = 0; i < n; i++) { const q = w.suns[i]; warmU.uSun.value[i].set(q.x, q.y, q.L); }
    warmU.uN.value = n; warmU.uLo.value = Math.log(w.F[0]); warmU.uHi.value = Math.log(w.F[1]);
    warmU.uColor.value.setRGB(w.rgb[0] / 255, w.rgb[1] / 255, w.rgb[2] / 255, THREE.SRGBColorSpace);
    warmU.uAlpha.value = additive ? 0.16 : 0.2;
    warm.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    warm.position.set(rig.cur.tx, 0, rig.cur.tz); warm.scale.setScalar(Math.max(1, rig.cur.dist * 12));   // reaches well past the edges of the view
  }

  /* ---------------------------------------------------------------- bodies */
  const actors = new Map(), live = new Set(), stars = [];
  const kindOf = b => (b.m >= 0.05 && b.kind !== 'planet' && b.kind !== 'moon' ? 'star' : b.kind === 'moon' ? 'moon' : b.kind === 'planet' ? 'planet' : 'giant');
  function makeActor(b, rgb, flux) {
    const kind = kindOf(b), group = new THREE.Group(), color = toColor(rgb), surface = surfaceOf(b, flux);
    let mesh, glow = null, atmo = null;
    if (kind === 'star') {
      mesh = new THREE.Mesh(sphere, starMaterial(color.clone().multiplyScalar(1.15), surface));
      glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color, transparent: true, depthWrite: false, opacity: 0.85, toneMapped: false }));
      group.add(glow);
    } else {
      mesh = new THREE.Mesh(sphere, worldMaterial(mapNamed(surface.name), surface.gas ? 0.7 : kind === 'moon' ? 0.95 : 0.88));
      if (surface.lava) { const m = mesh.material; m.emissiveMap = mapNamed('v5/planet-lava-glow'); m.emissive.setRGB(1, 0.32, 0.06); m.emissiveIntensity = 1.3; }
      if (kind === 'planet' && !surface.airless) { atmo = new THREE.Mesh(sphereLow, atmosphereMaterial()); atmo.scale.setScalar(1.07); atmo.renderOrder = 2; group.add(atmo); }
    }
    /* Spin about the body's own axis first, then lean that axis: a fixed axial tilt rather than a wobble. A tidally
     * locked world stands upright, or the face it keeps toward its sun would nod up and down once an orbit. */
    mesh.rotation.order = 'ZYX';
    mesh.rotation.z = b.meta && b.meta.locked ? 0 : { star: 0, planet: 0.41, moon: 0.12, giant: 0.2 }[kind];
    group.add(mesh);
    const geometry = new LineSegmentsGeometry();
    LineSegmentsGeometry.prototype.setPositions.call(geometry, new Float32Array(SEG_CAP * 6));
    LineSegmentsGeometry.prototype.setColors.call(geometry, new Float32Array(SEG_CAP * 6));
    geometry.instanceCount = 0;
    /* Ribbons blend normally even on the dark theme: additive segments would double up into beads at every joint. The
     * width is in CSS pixels: LineSegments2 sets the resolution from the renderer's viewport before every draw. */
    const material = new LineMaterial({ color: 0xffffff, linewidth: LINE_PX, vertexColors: true, worldUnits: false, transparent: false, opacity: 1, depthWrite: false, toneMapped: false });
    const line = new LineSegments2(geometry, material); line.frustumCulled = false; line.renderOrder = -1;
    scene.add(group, line);
    return { kind, group, mesh, glow, atmo, line, geometry, material, surface, name: b.meta && b.meta.name, locked: !!(b.meta && b.meta.locked), tone: kind === 'star' ? ((b.meta && b.meta.tone) || toneOf(b.id)) : kind, trailAt: -1, trailMode: '' };
  }
  function dropActor(id) {
    const a = actors.get(id); if (!a) return;
    scene.remove(a.group, a.line); a.geometry.dispose(); a.material.dispose(); a.mesh.material.dispose();
    if (a.glow) a.glow.material.dispose(); if (a.atmo) a.atmo.material.dispose();
    actors.delete(id);
  }
  const tmpColor = new THREE.Color(), bg = new THREE.Color();
  /* sRGB byte to linear light. The fade is mixed in sRGB, as the flat chart's canvas blends it, then converted: a mix in
   * linear light would wash every trail out toward the pale field of the light appearance. */
  const LIN = Float32Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  /* The trail: the flat page's own ring buffer and time window, thinned to the segment budget, fading toward the tail. */
  function fillTrail(a, tr, head, rgb, mode, tNow, tMin) {
    const pos = a.geometry.attributes.instanceStart.data, col = a.geometry.attributes.instanceColorStart.data, P = pos.array, C = col.array;
    let n = 0;
    for (let k = tr.len - 1; k >= 0; k--) { const i = tr.at(k), t = tr.t[i]; if (t > tNow) continue; if (t < tMin) break; n++; }
    const stride = Math.max(1, Math.ceil((n + 1) / (SEG_CAP + 1))), m = Math.min(SEG_CAP + 1, Math.floor(n / stride) + 1);
    if (m < 2) { a.geometry.instanceCount = 0; return; }
    const long = mode === 'long', base = 0.95, [r, g, b] = rgb, [fr, fg, fb] = theme.field;
    let j = 0, px = head.x, pz = -head.y, seg = 0;
    const put = (x, z, f) => {
      const al = long ? base * (0.3 + 0.7 * f * f) : base * Math.pow(f, 1.5);
      const cr = LIN[Math.round(fr + (r - fr) * al)], cg = LIN[Math.round(fg + (g - fg) * al)], cb = LIN[Math.round(fb + (b - fb) * al)];
      if (j > 0) { const o = 6 * seg; P[o] = px; P[o + 1] = 0; P[o + 2] = pz; P[o + 3] = x; P[o + 4] = 0; P[o + 5] = z; C[o] = C[o + 3] = cr; C[o + 1] = C[o + 4] = cg; C[o + 2] = C[o + 5] = cb; seg++; }
      px = x; pz = z; j++;
    };
    put(head.x, -head.y, 1);
    let seen = 0;
    for (let k = tr.len - 1; k >= 0 && seg < SEG_CAP; k--) {
      const i = tr.at(k), t = tr.t[i]; if (t > tNow) continue; if (t < tMin) break;
      if (seen++ % stride) continue;
      put(tr.x[i], -tr.y[i], 1 - (j - 1) / (m - 1));
    }
    a.geometry.instanceCount = seg;
    pos.clearUpdateRanges(); pos.addUpdateRange(0, seg * 6); pos.needsUpdate = true;   // upload the segments in use, not the whole budget
    col.clearUpdateRanges(); col.addUpdateRange(0, seg * 6); col.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- camera */
  const camPos = new THREE.Vector3(), target = new THREE.Vector3(), forward = new THREE.Vector3(), tmp = new THREE.Vector3();
  function applyCamera() {
    const c = rig.cur, off = cameraOffset(c.theta, c.phi, c.dist);
    target.set(c.tx, 0, c.tz); camPos.set(c.tx + off[0], off[1], c.tz + off[2]);
    camera.position.copy(camPos); camera.lookAt(target);
    camera.near = Math.max(0.0005, c.dist * 0.004); camera.far = Math.max(6000, c.dist * 60); camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    starfield.position.copy(camPos);       // the stars sit at infinity: they turn with the view but never come closer
    forward.subVectors(target, camPos).normalize();
    pxPerWorld = (view.h / 2) / (c.dist * tanFull);
  }
  function setCenter(cx, cy) {
    if (Math.abs(cx - view.cx) < 0.25 && Math.abs(cy - view.cy) < 0.25) return;
    view.cx = cx; view.cy = cy;
    camera.setViewOffset(view.w, view.h, view.w / 2 - cx, view.h / 2 - cy, view.w, view.h); camera.updateProjectionMatrix(); invalidate();
  }
  /* Screen position of a point on the plane, with the pixels per world unit at its depth; `behind` when it is behind the camera. */
  function project(x, y) {
    const depth = (x - camPos.x) * forward.x - camPos.y * forward.y + (-y - camPos.z) * forward.z;
    tmp.set(x, 0, -y).project(camera);
    const behind = depth < 1e-4;
    /* A point behind the camera projects mirrored through the centre; flip it back and push it well off screen, so the
     * chart's edge marker still points the right way instead of to a corner. */
    const k = behind ? -40 / Math.max(Math.abs(tmp.x), Math.abs(tmp.y), 0.05) : 1;
    return { x: (k * tmp.x + 1) / 2 * view.w, y: (1 - k * tmp.y) / 2 * view.h, s: (view.h / 2) / (Math.max(depth, 1e-4) * tanFull), behind };
  }
  /* The point on the plane under a screen position, or null when the ray misses the plane. */
  function unproject(X, Y) {
    tmp.set(X / view.w * 2 - 1, 1 - Y / view.h * 2, 0.5).unproject(camera).sub(camPos).normalize();
    if (Math.abs(tmp.y) < 1e-6) return null;
    const t = -camPos.y / tmp.y; if (t <= 0) return null;
    return [camPos.x + tmp.x * t, -(camPos.z + tmp.z * t)];
  }
  /* Zoom by a factor while the point on the plane under screen position (X, Y) stays exactly under it. */
  function dollyAt(factor, X, Y) {
    const before = unproject(X, Y);
    rig.dolly(factor, before ? [before[0], -before[1]] : null);
    if (!before || rig.mode === 'follow') return;
    applyCamera();
    const after = unproject(X, Y);
    if (!after) return;
    const dx = before[0] - after[0], dz = -(before[1] - after[1]);
    rig.cur.tx += dx; rig.cur.tz += dz; rig.goal.tx += dx; rig.goal.tz += dz;
    applyCamera();
  }
  /* Slide the view so that the point on the plane under (x0, y0) ends up under (x1, y1): a drag that pins the plane to the
   * finger at any tilt. Falls back to the rig's estimate when either point is above the horizon. */
  function panAt(x0, y0, x1, y1, leaveFollow) {
    if (rig.mode === 'follow' && !leaveFollow) return;   // a pinch keeps following; a deliberate slide looks elsewhere
    const a = unproject(x0, y0), b = unproject(x1, y1);
    if (a && b) rig.shift(a[0] - b[0], -(a[1] - b[1])); else rig.pan(x1 - x0, y1 - y0, pxPerWorld);
    applyCamera(); invalidate();
  }
  function updateCamera(env) {
    const pad = env.pad || 34, s = env.safe || { l: 0, t: 0, r: view.w, b: view.h };
    const tanV = tanFull * Math.max(30, (s.b - s.t) / 2 - pad) / (view.h / 2), tanH = tanFull * camera.aspect * Math.max(30, (s.r - s.l) / 2 - pad) / (view.w / 2);
    if (env.points) for (const p of env.points) p[1] = -p[1];   // the page hands over fresh points each frame; flip them to scene z in place
    const moved = rig.update({ dt: env.dt, points: env.points, follow: env.follow ? [env.follow[0], -env.follow[1]] : null,
      followDefault: env.followDefault, minHalf: env.minHalf, tanH, tanV, playing: env.playing, reduced: env.reduced, hold: env.hold });
    applyCamera();
    return moved;
  }

  /* ---------------------------------------------------------------- drawing */
  const lightDir = new THREE.Vector3(), white = new THREE.Color(1, 1, 1), byBrightness = (p, q) => LUM(q) - LUM(p);
  /* Direct light on a world scales as received^0.4 (see worldMaterial): about Earth's daylight at 1 AU from the Sun. */
  const DAY = { dark: 1.6, light: 1.35 };
  function render(frame) {
    const { bodies, drawn, trails, trailMode, tNow, tMin, climates, spinTime, quality, colorOf } = frame;
    live.clear(); stars.length = 0;
    for (const b of bodies) if (kindOf(b) === 'star') stars.push(b);
    stars.sort(byBrightness);
    ensureLights(stars.length);
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i], b = stars[i];
      if (!b) { l.intensity = 0; continue; }
      const rgb = colorOf(b);
      l.position.set(b.x, 0, -b.y); l.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
      l.intensity = Math.PI * LUM(b);      // irradiance L/d² in Earth units: a white surface at 1 AU from the Sun shows its own colour
    }
    const brightest = stars[0] || null;
    for (const b of bodies) {
      live.add(b.id);
      const rgb = colorOf(b), d = drawn.get(b.id);
      let a = actors.get(b.id);
      const kind = kindOf(b), tone = kind === 'star' ? ((b.meta && b.meta.tone) || toneOf(b.id)) : kind, locked = !!(b.meta && b.meta.locked);
      if (a && (a.kind !== kind || a.tone !== tone || a.locked !== locked || a.name !== (b.meta && b.meta.name)
        || ((a.surface.star || a.surface.gas) && surfaceOf(b, 1).name !== a.surface.name))) { dropActor(b.id); a = null; }   // the same id is another body after a setup change; a sun's or giant's map hangs on its mass alone
      if (!a) {
        let F = 0; for (const q of stars) if (q !== b) F += LUM(q) / Math.max(1e-12, (q.x - b.x) ** 2 + (q.y - b.y) ** 2);
        a = makeActor(b, rgb, F); actors.set(b.id, a);
      }
      const s = d && d.s ? d.s : pxPerWorld, r = (d ? d.r : 8) * (frame.trueSize ? 1 : SIZE_GAIN[a.kind]) / s;
      a.group.position.set(b.x, 0, -b.y);
      a.mesh.scale.setScalar(r);
      a.mesh.rotation.y = spinAngle(spinTime, SPIN_PERIODS[a.tone]) + (a.kind === 'star' ? STAR_PHASE[a.tone] : 0);
      if (locked) {                         // tidally locked: one face stays toward the sun that lights it most
        let host = null, bf = 0;
        for (const q of stars) if (q !== b) { const f = LUM(q) / ((q.x - b.x) ** 2 + (q.y - b.y) ** 2); if (f > bf) { bf = f; host = q; } }
        if (host) a.mesh.rotation.y = Math.atan2(host.y - b.y, host.x - b.x);
      }
      if (a.kind === 'star') {
        tmpColor.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
        a.mesh.material.emissive.copy(tmpColor).multiplyScalar(1.15);
        a.glow.material.color.copy(tmpColor); a.glow.material.opacity = additive ? 0.85 : 0.5; a.glow.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
        a.glow.scale.setScalar(r * GLOW_SCALE);
      } else {
        let flux = 0;
        for (const q of stars) if (q !== b) flux += LUM(q) / Math.max(1e-12, (q.x - b.x) ** 2 + (q.y - b.y) ** 2);
        const u = a.mesh.material.userData;
        u.exposure.value = Math.min(1e4, (additive ? DAY.dark : DAY.light) * Math.pow(Math.max(flux, 1e-9), -0.6));
        if (a.kind === 'planet' || a.kind === 'moon') {
          /* the climate washes a rocky world toward ice or ember; banded gas only takes a little of it */
          const c = climates ? (climates.get(b.id) ?? 2) : 2, tint = climateTint(c);
          u.tint.value.setRGB(tint.rgb[0], tint.rgb[1], tint.rgb[2]); u.amount.value = tint.amount * (a.surface.gas ? 0.35 : 1);
          if (!a.surface.lava) a.mesh.material.emissive.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace).lerp(white, 0.5);
          if (a.atmo) {
            a.atmo.visible = quality < 2;
            const at = atmosphereTint(c), au = a.atmo.material.uniforms;
            au.uColor.value.setRGB(at.rgb[0], at.rgb[1], at.rgb[2], THREE.SRGBColorSpace); au.uStrength.value = at.strength * (additive ? 1 : 0.55);
            if (brightest) lightDir.set(brightest.x - b.x, 0, -(brightest.y - b.y)).normalize(); else lightDir.set(1, 0, 0);
            au.uLight.value.copy(lightDir);
            a.atmo.scale.setScalar(r * 1.07);
          }
        }
      }
      const tr = trails && trails.get(b.id);
      if (surface.id !== null) a.line.visible = false;        // on the ground no trail is drawn: leave the buffers alone
      else if (tr && trailMode !== 'off') {
        if (a.trailAt !== tNow || a.trailMode !== trailMode || a.themeStamp !== themeStamp || a.trailLen !== tr.len) {
          fillTrail(a, tr, b, rgb, trailMode, tNow, tMin); a.trailAt = tNow; a.trailMode = trailMode; a.themeStamp = themeStamp; a.trailLen = tr.len;
        }
        a.line.visible = true;
      } else a.line.visible = false;
    }
    for (const id of actors.keys()) if (!live.has(id)) dropActor(id);   // deleting the current entry while iterating a Map is safe
    placeWarm(surface.id === null ? frame.warm : null);
    if (surface.id === null || !renderSurface(frame)) renderer.render(scene, camera);
    if (dirty > 0) dirty--;
  }

  /* ---------------------------------------------------------------- standing on a world */
  /* The observer stands at 30° north on the sphere the orbital view draws, at a longitude chosen on arrival so the
   * brightest sun is a little way up the morning sky; from then on the ground turns with that sphere. */
  const surface = { id: null, lon: null, look: new SkyLook(), view: null, info: null, dirs: new Map(), lost: false, phase: 0, lastT: null, day: null };
  function standOn(id) {
    if (!surface.view) { surface.view = createSurfaceView({ renderer, mapNamed }); surface.view.setSize(view.w, view.h); }
    surface.id = id; surface.lon = null; surface.lost = false; surface.info = null; surface.lastT = null; surface.day = null;
    surface.look.fov = 70; invalidate();
  }
  /* While standing, time slows so a solar day (see solarDay) lasts about eight seconds at 1×, half a minute at the
   * slowest speed. The day is worked out on arrival and again only if another sun becomes the host, so the pace does
   * not wander from frame to frame. */
  const DAY_SECONDS = 8;
  function dayFor(b) {
    const d = surface.day;
    if (d && !d.locked) {
      let host = null, bf = 0;
      for (const q of stars) if (q !== b) { const f = LUM(q) / Math.max(1e-12, (q.x - b.x) ** 2 + (q.y - b.y) ** 2); if (f > bf) { bf = f; host = q; } }
      if (host && host.id === d.host) return d;
    } else if (d) return d;
    const next = solarDay(b, stars, LUM);
    if (next && !next.locked) next.rate = next.solar / DAY_SECONDS;
    return next;
  }
  function leaveSurface() { surface.id = null; surface.info = null; surface.dirs.clear(); invalidate(); }
  const flatDir = (from, to) => { const dx = to.x - from.x, dz = -(to.y - from.y), d = Math.hypot(dx, dz) || 1e-12; return { dir: [dx / d, 0, dz / d], d }; };
  function renderSurface(frame) {
    const { bodies, climates, colorOf } = frame;
    const b = bodies.find(q => q.id === surface.id), a = actors.get(surface.id);
    if (!b || !a) { surface.lost = true; return false; }
    a.group.updateMatrixWorld(true);
    surface.day = dayFor(b);
    let axis, meridian;
    if (!surface.day || surface.day.locked) { const e = a.mesh.matrixWorld.elements; axis = [e[4], e[5], e[6]]; meridian = [e[0], e[1], e[2]]; }
    else {
      if (surface.lastT === null) surface.phase = a.mesh.rotation.y;   // arriving: the ground starts where the sphere was
      else if (frame.tNow > surface.lastT) surface.phase += surface.day.omega * (frame.tNow - surface.lastT);
      surface.lastT = frame.tNow;
      ({ axis, meridian } = spinFrame(surface.phase, a.mesh.rotation.z));
    }
    const lit = stars.filter(q => q !== b);
    if (surface.lon === null) {               // arriving: stand where the brightest sun is up, and face it
      let best = null, bf = -1;
      for (const q of lit) { const { d } = flatDir(b, q), f = LUM(q) / (d * d); if (f > bf) { bf = f; best = q; } }
      surface.lon = best ? standingLongitude(axis, meridian, LATITUDE, flatDir(b, best).dir) : 0;
      if (best) { const { alt, az } = altAz(toLocal(flatDir(b, best).dir, localFrame(axis, meridian, LATITUDE, surface.lon))); surface.look.az = az; surface.look.alt = clamp(alt * 0.55 + 6 * DEG, 4 * DEG, 40 * DEG); }
      surface.look.vaz = surface.look.valt = 0; surface.look.goal = null;
    }
    const basis = localFrame(axis, meridian, LATITUDE, surface.lon);
    surface.dirs.clear();
    const suns = lit.map(q => {
      const { dir, d } = flatDir(b, q), flux = LUM(q) / (d * d), { alt, az } = altAz(toLocal(dir, basis));
      surface.dirs.set(q.id, dir);
      return { id: q.id, dir, d, alt, az, flux, angR: angularRadius(starRadiusAU(q), d), rgb: colorOf(q), daylight: sunDaylight(alt, flux) };
    }).sort((p, q) => q.flux - p.flux);
    const worlds = bodies.filter(q => q !== b && kindOf(q) !== 'star').map(q => {
      const { dir, d } = flatDir(b, q), { alt, az } = altAz(toLocal(dir, basis));
      let host = null, f = 0;
      for (const s of stars) { const g = LUM(s) / Math.max(1e-12, (s.x - q.x) ** 2 + (s.y - q.y) ** 2); f += g; if (!host || g > host.g) host = { s, g }; }
      surface.dirs.set(q.id, dir);
      return { id: q.id, dir, d, alt, az, flux: f, angR: angularRadius(worldRadiusAU(q), d), rgb: colorOf(q), light: host ? flatDir(q, host.s).dir : [1, 0, 0] };
    });
    const daylight = skyDaylight(suns), climate = climates ? (climates.get(b.id) ?? 2) : 2;
    const gas = b.kind === 'planet' && worldRadiusAU(b) > 2 * R_EARTH_AU;   // past the radius valley: deep air and no ground
    const airless = !!a.surface.airless, atmo = airless ? { rgb: [0, 0, 0], strength: 0 } : atmosphereTint(climate);   // no air: a black sky by day
    surface.view.update({ basis, look: surface.look, suns, worlds, climate, atmo, airless, daylight: airless ? 0 : daylight, gas, surface: a.surface.name, seed: (b.id * 7919 + Math.round(b.m * 1e9)) >>> 0 });
    surface.view.render();
    surface.info = { id: b.id, suns, worlds, daylight, gas, radiusEarth: worldRadiusAU(b) / R_EARTH_AU };
    return true;
  }
  /* screen positions for the page's overlay: a body by id, or a point of the horizon by azimuth */
  function skyPoint(id) { const d = surface.dirs.get(id); return d && surface.view ? surface.view.projectDir(d) : null; }
  function horizonPoint(az) { return surface.view ? surface.view.projectLocal(Math.sin(az), Math.cos(az), 0) : null; }
  function lookDrag(dx, dy) { if (surface.view) { surface.look.drag(dx, dy, surface.look.fov / view.h); invalidate(); } }
  function lookFling(vx, vy) { if (surface.view) surface.look.fling(vx, vy, surface.look.fov / view.h); }
  function lookZoom(f) { surface.look.zoom(f); invalidate(); }
  function updateSurface(dt, reduced) { return surface.id !== null && surface.look.update(dt, reduced); }
  /* simulated time per second of playback at 1× while standing, or null to keep the setup's own pace */
  const surfaceRate = () => (surface.id !== null && surface.day && !surface.day.locked ? surface.day.rate : null);

  /* ---------------------------------------------------------------- page-facing setup */
  function resize(w, h, dpr) {
    view.w = Math.max(1, w); view.h = Math.max(1, h); view.dpr = clamp(dpr || 1, 1, view.quality >= 2 ? 1 : 2);
    renderer.setPixelRatio(view.dpr); renderer.setSize(view.w, view.h, false);
    if (surface.view) surface.view.setSize(view.w, view.h);
    camera.aspect = view.w / view.h;
    camera.setViewOffset(view.w, view.h, view.w / 2 - view.cx, view.h / 2 - view.cy, view.w, view.h); camera.updateProjectionMatrix();
    applyCamera(); invalidate();
  }
  function setQuality(q) { if (q !== view.quality) { view.quality = q; resize(view.w, view.h, view.dpr); } }
  const ambientDark = new THREE.Color(0x8fa0cc);
  function setTheme(t) {
    theme.ink = t.ink; theme.field = t.field; theme.moon = t.moon; additive = !!t.additive; themeStamp++;
    bg.copy(toColor(t.field)); scene.background = bg.clone();
    starfield.visible = additive;
    ambient.intensity = additive ? 0.22 : 0.9; ambient.color.copy(additive ? ambientDark : toColor(t.field));
    hemi.intensity = additive ? 0.18 : 0.35;
    for (const a of actors.values()) if (a.atmo) { a.atmo.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending; a.atmo.material.uniforms.uAdd.value = additive ? 1 : 0; }
    invalidate();
  }
  function clear() { for (const id of actors.keys()) dropActor(id); }
  function dispose() {
    clear(); warm.geometry.dispose(); warm.material.dispose(); canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', restored);
    for (const l of lights) { scene.remove(l); l.dispose(); }
    starfield.geometry.dispose(); starfield.material.dispose();
    if (surface.view) surface.view.dispose();
    renderer.dispose(); sphere.dispose(); sphereLow.dispose(); for (const m of mapCache.values()) m.dispose(); glowMap.dispose();
  }

  applyCamera();
  return { rig, camera, scene, renderer, resize, setQuality, setTheme, setCenter, project, unproject, dollyAt, panAt, updateCamera, render, clear, dispose,
    sizeGain: b => SIZE_GAIN[kindOf(b)], standOn, leaveSurface, surfaceRate, skyPoint, horizonPoint, lookDrag, lookFling, lookZoom, updateSurface,
    phoneLook, get surface() { return surface; }, get pxPerWorld() { return pxPerWorld; }, get dirty() { return dirty > 0; }, invalidate };
}
