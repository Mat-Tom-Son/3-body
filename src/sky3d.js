/* The 3D view of the flat page: the same bodies, trails, sizes and colours, drawn with three.js as lit, textured spheres
 * over the orbital plane. The page owns the simulation, the trails, the climate and every control; this module only
 * projects, frames and draws. Loaded on demand, so the flat page never pays for it. */
import * as THREE from 'three';
import { LineSegments2 } from '../vendor/LineSegments2.js';
import { LineSegmentsGeometry } from '../vendor/LineSegmentsGeometry.js';
import { LineMaterial } from '../vendor/LineMaterial.js';
import { CameraRig, cameraOffset, climateTint, atmosphereTint, spinAngle, SPIN_PERIODS, STAR_PHASE, toneOf, clamp, TAU } from './sky3d-model.js';

const FOV = 42, GLOW_SCALE = 7.5, SEG_CAP = 2200, LUM = m => Math.pow(m, 3.5);
const SIZE_GAIN = { star: 1, planet: 1.3, moon: 1.25, giant: 1.15 };   // worlds are a few pixels across; a sphere needs a little more than a disc to read
const assetRoot = new URL('../assets/bodies/', import.meta.url);

export function createSky3D({ canvas }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 6000);
  const rig = new CameraRig();
  const view = { w: 1, h: 1, dpr: 1, cx: 0, cy: 0, quality: 0 };
  const tanFull = Math.tan(FOV * Math.PI / 360);
  let pxPerWorld = 100, themeStamp = 0, additive = true;
  const theme = { ink: [234, 242, 250], field: [8, 23, 41], moon: [174, 185, 198] };
  /* The page gives sRGB bytes; three.js works in linear light, so every colour is converted on the way in. */
  const toColor = rgb => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  const linear = rgb => { const c = toColor(rgb); return [c.r, c.g, c.b]; };

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
    const m = new THREE.PointsMaterial({ color: 0xaab6d8, size: 1.7, sizeAttenuation: false, transparent: true, opacity: 0.7, depthWrite: false });
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; return pts;
  })();
  scene.add(starfield);

  /* ---------------------------------------------------------------- textures, geometry, shaders */
  const loader = new THREE.TextureLoader();
  const texture = name => { const t = loader.load(new URL(`${name}.webp`, assetRoot).href, () => invalidate()); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); return t; };
  const maps = { star: texture('star-surface'), planet: texture('planet-surface'), moon: texture('moon-surface') };
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

  /* A lit surface whose colours can be washed toward ice or ember with one mix in the fragment shader. */
  function worldMaterial(map, roughness) {
    const material = new THREE.MeshStandardMaterial({ map, roughness, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.16 });   // the night side keeps a faint picture of itself
    const tint = { value: new THREE.Color(1, 1, 1) }, amount = { value: 0 };
    material.onBeforeCompile = shader => {
      shader.uniforms.uTint = tint; shader.uniforms.uTintAmount = amount;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uTint;\nuniform float uTintAmount;')
        /* The climate wash keeps the map's light and dark structure, so ice or ember still show the turning surface. */
        .replace('#include <map_fragment>', '#include <map_fragment>\n\tfloat mapLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, uTint * (0.35 + 1.3 * mapLum), uTintAmount);');
    };
    material.customProgramCacheKey = () => 'sky3d-world';
    material.userData.tint = tint; material.userData.amount = amount;
    return material;
  }
  /* A sun: its own light, granulation from the shared map, darker toward the limb as real stars are. */
  function starMaterial(color) {
    const material = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveMap: maps.star, emissiveIntensity: 0.55, roughness: 1, metalness: 0 });
    material.onBeforeCompile = shader => {
      /* The granulation map is a low-contrast grey (about 0.22 linear); stretch it around its mean so the cells read as
       * the sun turns, then darken toward the limb. */
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>',
        '\tfloat grain = dot(texture2D(emissiveMap, vEmissiveMapUv).rgb, vec3(0.299, 0.587, 0.114));\n' +
        '\ttotalEmissiveRadiance *= mix(0.5, 1.35, clamp(0.5 + (grain - 0.22) * 6.0, 0.0, 1.0));\n' +
        '\tfloat limb = pow(saturate(dot(normalize(normal), normalize(vViewPosition))), 0.55);\n\ttotalEmissiveRadiance *= 0.42 + 0.78 * limb;');
    };
    material.customProgramCacheKey = () => 'sky3d-star';
    return material;
  }
  /* A thin atmosphere: a fresnel rim on a slightly larger shell, brighter on the sunlit side. */
  function atmosphereMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0.45, 0.75, 1) }, uStrength: { value: 0.8 }, uLight: { value: new THREE.Vector3(1, 0, 0) } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; varying vec3 vW;\nvoid main() { vec4 wp = modelMatrix * vec4(position, 1.0); vW = normalize(mat3(modelMatrix) * normal); vN = normalize(normalMatrix * normal); vV = normalize(-(modelViewMatrix * vec4(position, 1.0)).xyz); gl_Position = projectionMatrix * viewMatrix * wp; }',
      fragmentShader: 'uniform vec3 uColor; uniform float uStrength; uniform vec3 uLight; varying vec3 vN; varying vec3 vV; varying vec3 vW;\nvoid main() { float rim = pow(1.0 - clamp(dot(vN, vV), 0.0, 1.0), 2.6); float sun = 0.3 + 0.7 * clamp(dot(vW, uLight) * 0.8 + 0.35, 0.0, 1.0); gl_FragColor = vec4(uColor, 1.0) * rim * sun * uStrength; }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
    });
  }

  /* ---------------------------------------------------------------- bodies */
  const actors = new Map(), lineMaterials = new Set();
  const kindOf = b => (b.m >= 0.05 && b.kind !== 'planet' && b.kind !== 'moon' ? 'star' : b.kind === 'moon' ? 'moon' : b.kind === 'planet' ? 'planet' : 'giant');
  function makeActor(b, rgb) {
    const kind = kindOf(b), group = new THREE.Group(), color = toColor(rgb);
    let mesh, glow = null, light = null, atmo = null;
    if (kind === 'star') {
      mesh = new THREE.Mesh(sphere, starMaterial(color.clone().multiplyScalar(1.15)));
      glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color, transparent: true, depthWrite: false, opacity: 0.85 }));
      light = new THREE.PointLight(color, 1, 0, 2);
      group.add(glow, light);
    } else if (kind === 'planet') {
      mesh = new THREE.Mesh(sphere, worldMaterial(maps.planet, 0.88));
      atmo = new THREE.Mesh(sphereLow, atmosphereMaterial()); atmo.scale.setScalar(1.07); atmo.renderOrder = 2; group.add(atmo);
    } else if (kind === 'moon') mesh = new THREE.Mesh(sphere, worldMaterial(maps.moon, 0.95));
    else { mesh = new THREE.Mesh(sphere, worldMaterial(maps.moon, 0.75)); mesh.material.userData.tint.value.set(0.85, 0.6, 0.3); mesh.material.userData.amount.value = 0.55; }
    /* Spin about the body's own axis first, then lean that axis: a fixed axial tilt rather than a wobble. */
    mesh.rotation.order = 'ZYX';
    mesh.rotation.z = { star: 0, planet: 0.41, moon: 0.12, giant: 0.2 }[kind];
    group.add(mesh);
    const geometry = new LineSegmentsGeometry();
    LineSegmentsGeometry.prototype.setPositions.call(geometry, new Float32Array(SEG_CAP * 6));
    LineSegmentsGeometry.prototype.setColors.call(geometry, new Float32Array(SEG_CAP * 6));
    geometry.instanceCount = 0;
    /* Ribbons blend normally even on the dark theme: additive segments would double up into beads at every joint. */
    const material = new LineMaterial({ color: 0xffffff, linewidth: 1.8 * view.dpr, vertexColors: true, worldUnits: false, transparent: false, opacity: 1, depthWrite: false });
    material.resolution.set(view.w * view.dpr, view.h * view.dpr);
    lineMaterials.add(material);
    const line = new LineSegments2(geometry, material); line.frustumCulled = false; line.renderOrder = -1;
    scene.add(group, line);
    return { kind, group, mesh, glow, light, atmo, line, geometry, material, tone: kind === 'star' ? toneOf(b.id) : kind, trailAt: -1, trailMode: '' };
  }
  function dropActor(id) {
    const a = actors.get(id); if (!a) return;
    scene.remove(a.group, a.line); a.geometry.dispose(); a.material.dispose(); lineMaterials.delete(a.material); a.mesh.material.dispose();
    if (a.glow) a.glow.material.dispose(); if (a.atmo) a.atmo.material.dispose();
    actors.delete(id);
  }
  const tmpColor = new THREE.Color(), bg = new THREE.Color();
  /* The trail: the flat page's own ring buffer and time window, thinned to the segment budget, fading toward the tail. */
  function fillTrail(a, tr, head, rgb, mode, tNow, tMin) {
    const pos = a.geometry.attributes.instanceStart.data, col = a.geometry.attributes.instanceColorStart.data, P = pos.array, C = col.array;
    let n = 0;
    for (let k = tr.len - 1; k >= 0; k--) { const i = tr.at(k), t = tr.t[i]; if (t > tNow) continue; if (t < tMin) break; n++; }
    const stride = Math.max(1, Math.ceil((n + 1) / (SEG_CAP + 1))), m = Math.min(SEG_CAP + 1, Math.floor(n / stride) + 1);
    if (m < 2) { a.geometry.instanceCount = 0; return; }
    const long = mode === 'long', base = 0.95, [r, g, b] = linear(rgb);
    let j = 0, px = head.x, pz = -head.y, seg = 0;
    const put = (x, z, f) => {
      let al = long ? base * (0.3 + 0.7 * f * f) : base * Math.pow(f, 1.5);
      const cr = bg.r + (r - bg.r) * al, cg = bg.g + (g - bg.g) * al, cb = bg.b + (b - bg.b) * al;
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
    a.geometry.instanceCount = seg; pos.needsUpdate = true; col.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- camera */
  const camPos = new THREE.Vector3(), target = new THREE.Vector3(), forward = new THREE.Vector3(), tmp = new THREE.Vector3();
  function applyCamera() {
    const c = rig.cur, off = cameraOffset(c.theta, c.phi, c.dist);
    target.set(c.tx, 0, c.tz); camPos.set(c.tx + off[0], off[1], c.tz + off[2]);
    camera.position.copy(camPos); camera.lookAt(target);
    camera.near = Math.max(0.0005, c.dist * 0.004); camera.far = Math.max(6000, c.dist * 60); camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
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
    tmp.set(x, 0, -y);
    const depth = tmp.clone().sub(camPos).dot(forward);
    tmp.project(camera);
    const behind = depth < 1e-4;
    return { x: behind ? -1e6 : (tmp.x + 1) / 2 * view.w, y: behind ? -1e6 : (1 - tmp.y) / 2 * view.h, s: (view.h / 2) / (Math.max(depth, 1e-4) * tanFull), behind };
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
  function updateCamera(env) {
    const pad = env.pad || 34, s = env.safe || { l: 0, t: 0, r: view.w, b: view.h };
    const tanV = tanFull * Math.max(30, (s.b - s.t) / 2 - pad) / (view.h / 2), tanH = tanFull * camera.aspect * Math.max(30, (s.r - s.l) / 2 - pad) / (view.w / 2);
    const moved = rig.update({ dt: env.dt, points: env.points ? env.points.map(([x, y]) => [x, -y]) : null, follow: env.follow ? [env.follow[0], -env.follow[1]] : null,
      followDefault: env.followDefault, minHalf: env.minHalf, tanH, tanV, playing: env.playing, reduced: env.reduced, hold: env.hold });
    applyCamera();
    return moved;
  }

  /* ---------------------------------------------------------------- drawing */
  const lightDir = new THREE.Vector3();
  function render(frame) {
    const { bodies, drawn, trails, trailMode, tNow, tMin, climates, spinTime, quality, colorOf } = frame;
    const live = new Set();
    let brightest = null, bright = 0;
    for (const b of bodies) if (kindOf(b) === 'star') { const L = LUM(b.m); if (L > bright) { bright = L; brightest = b; } }
    for (const b of bodies) {
      live.add(b.id);
      const rgb = colorOf(b), d = drawn.get(b.id);
      let a = actors.get(b.id);
      if (!a) { a = makeActor(b, rgb); actors.set(b.id, a); }
      const s = d && d.s ? d.s : pxPerWorld, r = (d ? d.r : 8) * SIZE_GAIN[a.kind] / s;
      a.group.position.set(b.x, 0, -b.y);
      a.mesh.scale.setScalar(r);
      a.mesh.rotation.y = spinAngle(spinTime, SPIN_PERIODS[a.tone]) + (a.kind === 'star' ? STAR_PHASE[a.tone] : 0);
      a.mesh.visible = quality < 3;
      if (a.kind === 'star') {
        tmpColor.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
        a.mesh.material.emissive.copy(tmpColor).multiplyScalar(1.15);
        a.glow.material.color.copy(tmpColor); a.glow.material.opacity = additive ? 0.85 : 0.38; a.glow.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
        a.glow.scale.setScalar(r * GLOW_SCALE);
        a.light.color.copy(tmpColor); a.light.intensity = (additive ? 4.8 : 6) * LUM(b.m);
      } else if (a.kind === 'planet' || a.kind === 'moon') {
        const c = climates ? (climates.get(b.id) ?? 2) : 2, tint = climateTint(c), u = a.mesh.material.userData;
        u.tint.value.setRGB(tint.rgb[0], tint.rgb[1], tint.rgb[2]); u.amount.value = tint.amount;
        a.mesh.material.emissive.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace).lerp(new THREE.Color(1, 1, 1), 0.5);
        if (a.atmo) {
          a.atmo.visible = quality < 1;
          const at = atmosphereTint(c), au = a.atmo.material.uniforms;
          au.uColor.value.setRGB(at.rgb[0], at.rgb[1], at.rgb[2]); au.uStrength.value = at.strength * (additive ? 1 : 0.55);
          if (brightest) lightDir.set(brightest.x - b.x, 0, -(brightest.y - b.y)).normalize(); else lightDir.set(1, 0, 0);
          au.uLight.value.copy(lightDir);
          a.atmo.scale.setScalar(r * 1.07);
        }
      }
      const tr = trails && trails.get(b.id);
      if (tr && trailMode !== 'off') {
        if (a.trailAt !== tNow || a.trailMode !== trailMode || a.themeStamp !== themeStamp || a.trailLen !== tr.len) {
          fillTrail(a, tr, b, rgb, trailMode, tNow, tMin); a.trailAt = tNow; a.trailMode = trailMode; a.themeStamp = themeStamp; a.trailLen = tr.len;
        }
        a.line.visible = true;
      } else a.line.visible = false;
    }
    for (const id of [...actors.keys()]) if (!live.has(id)) dropActor(id);
    renderer.render(scene, camera);
    if (dirty > 0) dirty--;
  }

  /* ---------------------------------------------------------------- page-facing setup */
  function resize(w, h, dpr) {
    view.w = Math.max(1, w); view.h = Math.max(1, h); view.dpr = clamp(dpr || 1, 1, view.quality >= 2 ? 1 : 2);
    renderer.setPixelRatio(view.dpr); renderer.setSize(view.w, view.h, false);
    camera.aspect = view.w / view.h;
    camera.setViewOffset(view.w, view.h, view.w / 2 - view.cx, view.h / 2 - view.cy, view.w, view.h); camera.updateProjectionMatrix();
    for (const m of lineMaterials) { m.resolution.set(view.w * view.dpr, view.h * view.dpr); m.linewidth = 1.8 * view.dpr; }
    applyCamera(); invalidate();
  }
  function setQuality(q) { if (q !== view.quality) { view.quality = q; resize(view.w, view.h, view.dpr); } }
  function setTheme(t) {
    theme.ink = t.ink; theme.field = t.field; theme.moon = t.moon; additive = !!t.additive; themeStamp++;
    bg.copy(toColor(t.field)); scene.background = bg.clone();
    starfield.visible = additive;
    ambient.intensity = additive ? 0.22 : 0.9; ambient.color.copy(additive ? new THREE.Color(0x8fa0cc) : toColor(t.field));
    hemi.intensity = additive ? 0.18 : 0.35;
    for (const a of actors.values()) if (a.atmo) a.atmo.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    invalidate();
  }
  function clear() { for (const id of [...actors.keys()]) dropActor(id); }
  function dispose() { clear(); renderer.dispose(); sphere.dispose(); sphereLow.dispose(); for (const m of Object.values(maps)) m.dispose(); glowMap.dispose(); }

  applyCamera();
  return { rig, camera, scene, renderer, resize, setQuality, setTheme, setCenter, project, unproject, dollyAt, updateCamera, render, clear, dispose,
    get pxPerWorld() { return pxPerWorld; }, get dirty() { return dirty > 0; }, invalidate };
}
