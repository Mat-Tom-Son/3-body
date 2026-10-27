/* The view from the ground: a sky, a horizon and the bodies above it, for an observer standing on a world of the 3D
 * view. Drawn in the observer's own frame (x east, y up, -z north) with the camera at the origin, so a world hundreds of
 * AU from the centre of its system loses no precision. Everything in the sky sits in one group whose matrix turns scene
 * directions into that frame; the page's simulation decides where each body is, this file only draws it. */
import * as THREE from 'three';
import { DEG, smoothstep, groundTiles, GLOW_OF } from './surface-model.js';

const MAX_SUNS = 6, R_SKY = 3000, R_STARS = 2800, R_SUNS = 2500, R_WORLDS = 2400;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createSurfaceView({ renderer, mapNamed }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 6000); camera.rotation.order = 'YXZ';
  const view = { w: 1, h: 1, seed: 0 };
  const sky = new THREE.Group(); sky.matrixAutoUpdate = false; scene.add(sky);
  const tmp = new THREE.Vector3(), q = new THREE.Quaternion(), fw = new THREE.Vector3(), orange = new THREE.Color(1, 0.38, 0.12);
  let basis = { east: [1, 0, 0], north: [0, 0, -1], up: [0, 1, 0] };
  const toSurf = (d, out) => out.set(d[0] * basis.east[0] + d[1] * basis.east[1] + d[2] * basis.east[2], d[0] * basis.up[0] + d[1] * basis.up[1] + d[2] * basis.up[2],
    -(d[0] * basis.north[0] + d[1] * basis.north[1] + d[2] * basis.north[2]));

  /* ---------------------------------------------------------------- the sky dome: night, day, twilight and sun glare */
  const sunDir = Array.from({ length: MAX_SUNS }, () => new THREE.Vector3(0, -1, 0)), sunCol = Array.from({ length: MAX_SUNS }, () => new THREE.Color(0, 0, 0));
  const sunPow = new Float32Array(MAX_SUNS);
  const skyU = { uSunDir: { value: sunDir }, uSunCol: { value: sunCol }, uSunPow: { value: sunPow }, uAtmo: { value: new THREE.Color(0.3, 0.55, 1) }, uThin: { value: 1 },
    uNight: { value: new THREE.Color(0.0016, 0.0035, 0.009) }, uDay: { value: 0 }, uAir: { value: 1 } };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyU, side: THREE.BackSide, depthWrite: false, toneMapped: false,
    vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      #define MAX_SUNS ${MAX_SUNS}
      uniform vec3 uSunDir[MAX_SUNS]; uniform vec3 uSunCol[MAX_SUNS]; uniform float uSunPow[MAX_SUNS];
      uniform vec3 uAtmo; uniform vec3 uNight; uniform float uDay; uniform float uThin; uniform float uAir;
      varying vec3 vDir;
      void main() {
        vec3 v = normalize(vDir); float h = clamp(v.y, 0.0, 1.0), below = clamp(-v.y * 8.0, 0.0, 1.0);
        vec3 night = uNight * (1.4 - 0.6 * h), acc = vec3(0.0), glow = vec3(0.0); float wsum = 0.0;
        for (int i = 0; i < MAX_SUNS; i++) {
          float s = uSunPow[i]; if (s <= 0.0) continue;
          vec3 d = uSunDir[i]; float mu = dot(v, d), low = 1.0 - smoothstep(-0.05, 0.4, d.y);
          vec3 zenith = uAtmo * 0.55, horizon = mix(uAtmo, vec3(1.0), 0.55 * uThin) * 0.9;
          vec3 base = mix(zenith, horizon, pow(1.0 - h, 2.5));
          /* a low sun reddens the air along the horizon, most of all on its own side of the sky */
          vec3 warm = mix(vec3(1.0, 0.42, 0.16), uSunCol[i], 0.25);
          base = mix(base, warm, low * pow(1.0 - h, 1.6) * (0.25 + 0.75 * pow(max(mu, 0.0), 2.0)));
          base *= mix(1.0, 0.25 + 0.75 * smoothstep(-0.2, 0.15, d.y), low);
          acc += s * base; wsum += s;
          glow += s * uSunCol[i] * (0.35 * pow(max(mu, 0.0), 12.0) + 1.4 * pow(max(mu, 0.0), 220.0));
        }
        /* more suns make the sky brighter, never whiter: the colour is the suns' weighted mix, the brightness saturates */
        vec3 day = wsum > 0.0 ? acc / wsum * (1.0 - exp(-1.7 * wsum)) * 1.2 * uAir : vec3(0.0);   // no air, no day sky: black around the sun
        vec3 col = night + day + glow * (0.35 + 0.65 * uAir);
        col = mix(col, col * 0.55, below);
        col = col / (1.0 + 0.25 * max(col.r, max(col.g, col.b)));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(R_SKY, 48, 24), skyMat); dome.renderOrder = -10; dome.frustumCulled = false; scene.add(dome);

  /* ---------------------------------------------------------------- stars, fixed to the sky and turning with the world */
  const stars = (() => {
    const n = 3200, p = new Float32Array(3 * n), c = new Float32Array(3 * n);
    let seed = 11; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < n; i++) {
      const z = 2 * rnd() - 1, a = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z), b = Math.pow(rnd(), 3.2) * 0.9 + 0.1, warm = rnd();
      p.set([r * Math.cos(a) * R_STARS, z * R_STARS, r * Math.sin(a) * R_STARS], 3 * i);
      c.set([b * (0.85 + 0.15 * warm), b * 0.92, b * (1.05 - 0.2 * warm)], 3 * i);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const mat = new THREE.PointsMaterial({ size: 1.8, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = -9; return pts;
  })();
  sky.add(stars);
  /* the galaxy behind the stars: a panorama fixed to the sky, leant as the Milky Way leans to a planet's orbit */
  /* only its middle band is kept: toward the panorama's poles its stars are pinched into streaks, and the point stars
   * already fill the rest of the sky */
  const milky = new THREE.Mesh(new THREE.SphereGeometry(R_STARS + 40, 64, 32), new THREE.ShaderMaterial({
    uniforms: { uMap: { value: mapNamed('v5/sky-milkyway') }, uOpacity: { value: 0 } }, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D uMap; uniform float uOpacity; varying vec2 vUv;
      void main() { float band = 1.0 - smoothstep(0.32, 0.62, abs(vUv.y - 0.5) * 2.0); vec3 c = texture2D(uMap, vUv).rgb;
        gl_FragColor = vec4(c * band * uOpacity, 1.0);
        #include <colorspace_fragment>
      }`,
  }));
  milky.rotation.set(1.05, 0.4, 0.3); milky.renderOrder = -9.5; milky.frustumCulled = false; sky.add(milky);

  /* ---------------------------------------------------------------- the ground and two ridges of hills on the horizon */
  /* The ground is painted from repeating tiles (asset set v5): two of them blended by the climate, sampled at two scales
   * so the repeat does not show, with the old colour as a tint. A glow mask lights the cracks of scorched ground. */
  const tile = name => { const t = mapNamed(name); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t; };
  const groundU = { uColor: { value: new THREE.Color() }, uLight: { value: 0 }, uHaze: { value: new THREE.Color() }, uGlow: { value: new THREE.Color(0, 0, 0) }, uFar: { value: 1 },
    uTexA: { value: tile('v5/ground-grassland') }, uTexB: { value: tile('v5/ground-grassland') }, uMix: { value: 0 }, uGlowTex: { value: tile('v5/ground-scorched-glow') } };
  const groundMat = (far, ridgeRadius = 0) => new THREE.ShaderMaterial({
    uniforms: { ...groundU, uFar: { value: far }, uRidge: { value: ridgeRadius } }, toneMapped: false,
    vertexShader: 'varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uColor; uniform float uLight; uniform vec3 uHaze; uniform vec3 uGlow; uniform float uFar; varying vec3 vP;
      uniform sampler2D uTexA; uniform sampler2D uTexB; uniform float uMix; uniform sampler2D uGlowTex; uniform float uRidge;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
      vec3 ground(vec2 uv) { return mix(texture2D(uTexA, uv).rgb, texture2D(uTexB, uv).rgb, uMix); }
      void main() {
        /* the ground is painted from above; a hill's face is painted along the skyline and up it, or a flat sample
         * would run down it in stripes */
        vec2 st = uRidge > 0.0 ? vec2(atan(vP.x, -vP.z) * uRidge, vP.y * 2.0) * 0.02 : vP.xz;
        float dist = length(vP.xz), grain = 0.8 + 0.4 * noise(st * 0.05);
        vec3 albedo = mix(ground(st * 0.16), ground(st * 0.023 + 0.37), 0.35) * uColor;
        float cracks = texture2D(uGlowTex, st * 0.16).r;
        vec3 lit = albedo * grain * (0.03 + uLight) + uGlow * cracks * 3.0;
        float haze = clamp(smoothstep(20.0, 1700.0, dist) * 0.85 + uFar * 0.25, 0.0, 1.0);
        vec3 col = mix(lit, uHaze, haze);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(2000, 96).rotateX(-Math.PI / 2).translate(0, -1.6, 0), groundMat(0)); scene.add(ground);
  const ridge = (radius, height, octave, far) => {
    const n = 720, pos = new Float32Array(n * 2 * 3), idx = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * 2 * Math.PI, x = Math.sin(a) * radius, z = -Math.cos(a) * radius;
      pos.set([x, -1.6, z, x, 0, z], 6 * i);
      const j = (i + 1) % n; idx.push(2 * i, 2 * j, 2 * i + 1, 2 * i + 1, 2 * j, 2 * j + 1);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx);
    const mesh = new THREE.Mesh(g, groundMat(far, radius)); mesh.userData = { radius, height, octave, n }; return mesh;
  };
  const ridges = [ridge(1750, 2.6, 3, 1), ridge(1150, 1.7, 5, 0.45)]; ridges.forEach(r => scene.add(r));
  /* each world has its own skyline, from a seed: low rolling hills with the odd taller rise */
  function shapeRidges(seed) {
    for (const r of ridges) {
      const { radius, height, octave, n } = r.userData, pos = r.geometry.attributes.position.array;
      let s = (seed * 2654435761 + octave * 97) >>> 0; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
      const waves = Array.from({ length: 7 }, (_, k) => ({ f: Math.round((k + 1) * octave * (0.6 + 0.8 * rnd())), p: 2 * Math.PI * rnd(), a: 1 / (k + 1.3) }));
      for (let i = 0; i < n; i++) {
        const a = i / n * 2 * Math.PI; let h = 0;
        for (const w of waves) h += w.a * Math.sin(w.f * a + w.p);
        const deg = Math.max(0.08, height * (0.45 + 0.35 * h));
        pos[6 * i + 4] = Math.tan(deg * DEG) * radius - 1.6;
      }
      r.geometry.attributes.position.needsUpdate = true; r.geometry.computeBoundingSphere();
    }
  }
  shapeRidges(1);

  /* ---------------------------------------------------------------- suns and worlds: discs that face the observer */
  const quad = new THREE.PlaneGeometry(2, 2);
  const sunMaterial = () => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uCore: { value: 1 }, uGlow: { value: 1 }, uSpan: { value: 8 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uColor; uniform float uCore; uniform float uGlow; uniform float uSpan; varying vec2 vUv;
      void main() {
        float r = length(vUv) * uSpan;                      // in radii of the sun's disc
        float disc = 1.0 - smoothstep(0.92, 1.08, r);
        float limb = 0.55 + 0.45 * sqrt(max(1.0 - r * r, 0.0));
        float x = max(r - 1.0, 0.0);
        float halo = uGlow * (0.32 * exp(-x * 2.2) + 0.07 / (1.0 + 0.3 * x * x)) * smoothstep(0.92, 1.06, r) * (1.0 - smoothstep(0.7 * uSpan, uSpan, r));
        vec3 core = mix(uColor, vec3(1.0), 0.45);
        gl_FragColor = vec4(core * disc * limb * uCore + uColor * halo, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const worldMaterial = () => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uLight: { value: new THREE.Vector3(1, 0, 0) }, uBright: { value: 1 }, uSpan: { value: 1.3 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,   // a world adds its light: its night side is lost in the sky behind it, as it is to the eye
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uColor; uniform vec3 uLight; uniform float uBright; uniform float uSpan; varying vec2 vUv;
      void main() {
        vec2 p = vUv * uSpan; float r = length(p);
        float edge = 1.0 - smoothstep(0.9, 1.1, r); if (edge <= 0.0) discard;
        vec3 n = vec3(p, sqrt(max(1.0 - r * r, 0.0)));
        float lit = smoothstep(-0.08, 0.12, dot(n, uLight)) * (0.35 + 0.65 * max(dot(n, uLight), 0.0));
        gl_FragColor = vec4(uColor * lit * uBright * edge, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const items = new Map();                  // id -> { mesh, kind }
  function itemFor(id, kind) {
    let it = items.get(id);
    if (it && it.kind !== kind) { sky.remove(it.mesh); it.mesh.material.dispose(); it = null; }
    if (!it) { it = { kind, mesh: new THREE.Mesh(quad, kind === 'sun' ? sunMaterial() : worldMaterial()) }; it.mesh.renderOrder = kind === 'sun' ? -5 : -6; sky.add(it.mesh); items.set(id, it); }
    return it;
  }

  /* ---------------------------------------------------------------- one frame */
  const seen = new Set(), lightLocal = new THREE.Vector3(), surfDir = new THREE.Vector3();
  function update(f) {
    basis = f.basis;
    sky.matrix.set(basis.east[0], basis.east[1], basis.east[2], 0, basis.up[0], basis.up[1], basis.up[2], 0, -basis.north[0], -basis.north[1], -basis.north[2], 0, 0, 0, 0, 1);
    sky.matrixWorldNeedsUpdate = true;
    if (f.seed !== view.seed) { view.seed = f.seed; shapeRidges(f.seed); }
    camera.fov = f.look.fov; camera.rotation.set(f.look.alt, -f.look.az, 0); camera.updateProjectionMatrix();
    scene.updateMatrixWorld();
    const pxPerRad = (view.h / 2) / Math.tan(camera.fov * DEG / 2);

    /* the air: thick and blue on a living world, thin and pale on a frozen one, orange haze on a burning one */
    skyU.uAtmo.value.setRGB(f.atmo.rgb[0], f.atmo.rgb[1], f.atmo.rgb[2], THREE.SRGBColorSpace).multiplyScalar(Math.min(1, f.atmo.strength));
    skyU.uThin.value = clamp(f.atmo.strength, 0.3, 1.2); skyU.uAir.value = f.airless ? 0 : 1;
    let k = 0, groundLight = 0;
    seen.clear();
    for (const s of f.suns) {
      seen.add(s.id);
      toSurf(s.dir, surfDir);
      const alt = Math.asin(clamp(surfDir.y, -1, 1)), lowness = 1 - smoothstep(-2 * DEG, 14 * DEG, alt);
      /* the sky: the brightest suns light it (the compressed light rule of the worlds), a distant one is only a star */
      if (k < MAX_SUNS && s.daylight > 1e-4) {
        sunDir[k].copy(surfDir); sunCol[k].setRGB(s.rgb[0] / 255, s.rgb[1] / 255, s.rgb[2] / 255, THREE.SRGBColorSpace);
        sunPow[k] = s.daylight; k++;
      }
      groundLight += Math.pow(Math.max(s.flux, 0), 0.4) * Math.max(0, Math.sin(alt)) * 0.9;
      const it = itemFor(s.id, 'sun'), mat = it.mesh.material, u = mat.uniforms;
      const discR = Math.max(s.angR, 1.6 / pxPerRad), span = clamp(3 + 5 * Math.pow(Math.max(s.flux, 0), 0.25), 2.5, 9);
      it.mesh.position.set(s.dir[0], s.dir[1], s.dir[2]).multiplyScalar(R_SUNS);   // the group turns scene directions into the sky
      it.mesh.scale.setScalar(R_SUNS * Math.tan(discR) * span);
      it.mesh.lookAt(0, 0, 0);
      u.uSpan.value = span;
      const tint = u.uColor.value.setRGB(s.rgb[0] / 255, s.rgb[1] / 255, s.rgb[2] / 255, THREE.SRGBColorSpace);
      if (lowness > 0) tint.lerp(orange, 0.7 * lowness * f.atmo.strength);
      /* a sun drawn larger than it is (a point of light far away) keeps the light of its real disc */
      const shrink = Math.min(1, Math.pow(s.angR / discR, 2) * 30);
      u.uCore.value = (1.25 + 0.75 * Math.min(1, Math.pow(s.flux, 0.2))) * Math.max(0.25, shrink) * (1 - 0.55 * lowness) * (s.angR < discR ? 1 - 0.7 * f.daylight : 1);
      u.uGlow.value = clamp(Math.pow(Math.max(s.flux, 0), 0.3), 0.04, 1.6) * (1 - 0.4 * lowness) * (f.airless ? 0.3 : 1);   // no air to scatter it: only the eye's own glare
      it.mesh.visible = true;
    }
    for (let i = k; i < MAX_SUNS; i++) sunPow[i] = 0;
    skyU.uDay.value = f.daylight;
    stars.material.opacity = f.airless ? 1 : Math.pow(1 - f.daylight, 2.2);   // with no air the stars shine by day
    milky.material.uniforms.uOpacity.value = 1.1 * Math.pow(1 - f.daylight, 3);

    for (const w of f.worlds) {
      seen.add(w.id);
      toSurf(w.dir, surfDir);
      const it = itemFor(w.id, 'world'), u = it.mesh.material.uniforms;
      const discR = Math.max(w.angR, 1.25 / pxPerRad);
      it.mesh.position.set(w.dir[0], w.dir[1], w.dir[2]).multiplyScalar(R_WORLDS);
      it.mesh.scale.setScalar(R_WORLDS * Math.tan(discR) * 1.3);
      it.mesh.lookAt(0, 0, 0);
      it.mesh.updateMatrixWorld();
      /* the sunlit side: the light's direction in the disc's own frame, so the phase is right from where we stand */
      toSurf(w.light, lightLocal); it.mesh.getWorldQuaternion(q); lightLocal.applyQuaternion(q.invert()).normalize();
      u.uLight.value.copy(lightLocal);
      u.uColor.value.setRGB(w.rgb[0] / 255, w.rgb[1] / 255, w.rgb[2] / 255, THREE.SRGBColorSpace);
      const small = Math.min(1, Math.pow(w.angR / discR, 2) * 60);   // a world too small to see as a disc shines as a point
      u.uBright.value = clamp(Math.pow(Math.max(w.flux, 0), 0.35), 0.2, 2.2) * (0.9 + 0.6 * (1 - f.daylight)) * Math.max(0.35, small) * (w.angR < discR ? 1 - 0.6 * f.daylight : 1);
      it.mesh.visible = true;
    }
    for (const [id, it] of items) if (!seen.has(id)) { sky.remove(it.mesh); it.mesh.material.dispose(); items.delete(id); }

    /* the ground, lit by every sun above the horizon and by the sky itself; a burning world glows at night */
    for (const r of ridges) r.visible = !f.gas;
    const [ta, tb, mixT] = groundTiles(f);
    groundU.uTexA.value = tile(ta); groundU.uTexB.value = tile(tb); groundU.uMix.value = mixT;
    groundU.uColor.value.setRGB(1, 1, 1);   // the tiles carry the colour now
    groundU.uLight.value = groundLight + 0.25 * f.daylight;
    /* only scorched rock and open lava glow, each through its own mask; the mask follows the first tile's sampling */
    const hot = GLOW_OF[ta] ? ta : GLOW_OF[tb] ? tb : null, lava = hot === 'v6/ground-lava';
    if (hot) groundU.uGlowTex.value = tile(GLOW_OF[hot]);
    const hz = f.airless ? [0.004, 0.005, 0.008] : horizonColor(f), glow = !hot ? 0 : (lava ? 0.7 : f.surface === 'v5/planet-lava' ? 1 : smoothstep(3.4, 4, f.climate)) * 0.05;
    groundU.uHaze.value.setRGB(hz[0], hz[1], hz[2]);
    groundU.uGlow.value.setRGB(glow * 1.4, glow * 0.25, glow * 0.04);
  }
  /* the colour of the air at the horizon, for the haze over the distant ground: the dome's own sum, taken at altitude 0 */
  function horizonColor(f) {
    const night = skyU.uNight.value, acc = [0, 0, 0], atmo = skyU.uAtmo.value, thin = 0.55 * skyU.uThin.value;
    let wsum = 0;
    for (let i = 0; i < MAX_SUNS; i++) {
      const s = sunPow[i]; if (s <= 0) continue;
      const low = 1 - smoothstep(-0.05, 0.4, sunDir[i].y), lift = 0.25 + 0.75 * smoothstep(-0.2, 0.15, sunDir[i].y);
      const hor = [atmo.r + (1 - atmo.r) * thin, atmo.g + (1 - atmo.g) * thin, atmo.b + (1 - atmo.b) * thin].map(v => v * 0.9), warm = [1, 0.42, 0.16];
      for (let c = 0; c < 3; c++) acc[c] += s * (hor[c] + (warm[c] - hor[c]) * low * 0.45) * (1 + (lift - 1) * low);
      wsum += s;
    }
    const k = wsum > 0 ? (1 - Math.exp(-1.7 * wsum)) * 1.2 / wsum : 0;
    return [night.r * 1.4 + acc[0] * k, night.g * 1.4 + acc[1] * k, night.b * 1.4 + acc[2] * k].map(v => v * 0.85);
  }

  function render() { renderer.render(scene, camera); }
  function setSize(w, h) { view.w = Math.max(1, w); view.h = Math.max(1, h); camera.aspect = view.w / view.h; camera.updateProjectionMatrix(); }
  /* where a direction of the observer's frame ([east, north, up]) lands on the screen, or null behind the viewer */
  function projectLocal(e, n, u) {
    tmp.set(e, u, -n).multiplyScalar(100);
    camera.getWorldDirection(fw);
    if (tmp.dot(fw) <= 0) return null;
    tmp.project(camera);
    return { x: (tmp.x + 1) / 2 * view.w, y: (1 - tmp.y) / 2 * view.h };
  }
  /* the same for a scene direction (a body seen from the observer), with whether it is above the horizon */
  function projectDir(d) { toSurf(d, surfDir); const p = projectLocal(surfDir.x, -surfDir.z, surfDir.y); return p && { ...p, up: surfDir.y > 0 }; }
  function frameDir(d) { toSurf(d, surfDir); return [surfDir.x, -surfDir.z, surfDir.y]; }
  const pxPerDeg = () => (view.h / 2) / Math.tan(camera.fov * DEG / 2) * DEG;
  function dispose() {
    for (const it of items.values()) it.mesh.material.dispose(); items.clear();
    quad.dispose(); dome.geometry.dispose(); skyMat.dispose(); stars.geometry.dispose(); stars.material.dispose(); milky.geometry.dispose(); milky.material.dispose();
    for (const m of [ground, ...ridges]) { m.geometry.dispose(); m.material.dispose(); }
  }
  return { update, render, setSize, projectLocal, projectDir, frameDir, pxPerDeg, dispose, camera };
}
