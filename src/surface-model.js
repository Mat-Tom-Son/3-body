/* Standing on a world: where its suns, neighbours and stars sit in its sky. Pure arithmetic on scene vectors (the
 * orbital plane is the floor, the simulation's y is -z, up is +y), so every rule is checked headlessly. The observer
 * stands on the very sphere the 3D view draws: its spin axis and prime meridian come from that sphere's orientation,
 * so a sunrise seen from the ground is the same turn of the world seen from space. */
export const DEG = Math.PI / 180;
export const R_SUN_AU = 0.00465047;          // the Sun's radius in AU (IAU nominal 695,700 km)
export const R_EARTH_AU = 4.26352e-5;         // Earth's equatorial radius in AU (6,378 km)
export const M_EARTH_SUNS = 1 / 332946.05;
export const LATITUDE = 30 * DEG;             // where the observer stands: far enough from the equator for slanted arcs and seasons

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* The local frame of an observer at latitude lat and longitude lon on a sphere whose spin axis is `axis` and whose prime
 * meridian points along `meridian` (both unit vectors in scene space). East is the way the ground is carried by the spin,
 * so suns rise in the east. Returns unit vectors { up, east, north }. */
export function localFrame(axis, meridian, lat, lon) {
  const A = norm(axis), X = norm(meridian), W = cross(A, X);          // W: a quarter turn ahead of the meridian
  const c = Math.cos(lat), s = Math.sin(lat), cl = Math.cos(lon), sl = Math.sin(lon);
  const up = norm([c * (cl * X[0] + sl * W[0]) + s * A[0], c * (cl * X[1] + sl * W[1]) + s * A[1], c * (cl * X[2] + sl * W[2]) + s * A[2]]);
  let east = cross(A, up);
  if (Math.hypot(east[0], east[1], east[2]) < 1e-9) east = cross([0, 1, 0], up);   // standing on a pole: any east will do
  east = norm(east);
  return { up, east, north: cross(up, east) };
}
/* A scene direction in the observer's frame: [east, north, up] components. */
export const toLocal = (dir, f) => [dot(dir, f.east), dot(dir, f.north), dot(dir, f.up)];
/* Altitude above the horizon and azimuth from north through east, both in radians; azimuth in [0, 2π). */
export function altAz(local) {
  const [e, n, u] = norm(local);
  let az = Math.atan2(e, n); if (az < 0) az += 2 * Math.PI;
  return { alt: Math.asin(clamp(u, -1, 1)), az };
}
const WINDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const windOf = az => WINDS[Math.round(((az / (2 * Math.PI)) % 1 + 1) % 1 * 8) % 8];

/* Sizes. A body may carry a published radius (meta.radius: suns in solar radii, worlds in Earth radii). Otherwise the
 * mass–radius relation of Chen & Kipping 2017 (ApJ 834, 17): rocky worlds R = 1.008 M^0.279 below 2.04 Earth masses,
 * then M^0.589 up to the size of Jupiter, and stars R ≈ 0.96 M^0.88 (the stellar branch, joined end to end; past
 * 0.87 Suns it is an extrapolation). Returned in AU. */
export function starRadiusAU(b) {
  const R = b.meta && b.meta.radius != null ? b.meta.radius : 0.96 * Math.pow(Math.max(b.m, 0.01), 0.88);
  return R * R_SUN_AU;
}
const ROCKY_TOP = 1.008 * Math.pow(2.04, 0.279);
export function worldRadiusAU(b) {
  if (b.meta && b.meta.radius != null) return b.meta.radius * R_EARTH_AU;
  const mE = Math.max(b.m / M_EARTH_SUNS, 1e-4);
  const R = mE < 2.04 ? 1.008 * Math.pow(mE, 0.279) : Math.min(10.97, ROCKY_TOP * Math.pow(mE / 2.04, 0.589));
  return R * R_EARTH_AU;
}
export const angularRadius = (R, d) => Math.asin(clamp(R / Math.max(d, R * 1.0001), 0, 1));

/* How much daylight a sun gives the sky: its light (flux, in Earth's sunlight) compressed, as an eye adapts (a sky lit by
 * a fiftieth of the Sun's light is still a blue day sky), and faded through twilight as it goes down. A sun so far off
 * that it gives less than a thousandth of Earth's light is a star, however bright. The sky's total is 0 at night and
 * approaches 1 at full day. */
export const sunDaylight = (alt, flux) => Math.pow(Math.max(flux, 0), 0.25) * smoothstep(1e-5, 1e-3, flux) * smoothstep(-10 * DEG, 8 * DEG, alt);
export const skyDaylight = suns => 1 - Math.exp(-1.8 * suns.reduce((s, q) => s + sunDaylight(q.alt, q.flux), 0));

/* Where to stand: the longitude at which the given sun sits nearest `want` above the horizon, rising in the east when
 * the world turns. A tidally locked world never turns under its sun, so there the choice is simply how high it hangs. */
export function standingLongitude(axis, meridian, lat, sunDir, want = 24 * DEG) {
  let best = 0, score = Infinity;
  for (let k = 0; k < 360; k++) {
    const lon = k * DEG, { alt, az } = altAz(toLocal(sunDir, localFrame(axis, meridian, lat, lon)));
    const s = Math.abs(alt - want) + (az > Math.PI ? 0.5 : 0);   // prefer morning: the sun in the eastern half of the sky
    if (s < score) { score = s; best = lon; }
  }
  return best;
}

/* The spin axis and prime meridian of a sphere turned as the 3D view turns it: three.js Euler (0, phase, tilt) in order
 * 'ZYX', that is a spin about the body's own axis, then that axis leant by the tilt. */
export function spinFrame(phase, tilt) {
  const cp = Math.cos(phase), sp = Math.sin(phase), ct = Math.cos(tilt), st = Math.sin(tilt);
  return { axis: [-st, ct, 0], meridian: [ct * cp, st * cp, -sp] };
}
/* The ground's own day. The sphere seen from space turns at a presentation pace, a few turns a year, which from the
 * ground would let the year outrun the day. So a standing observer's world turns by its solar day: meta.days solar days
 * a year where known (Earth), `unknownDays` where not, and none for a tidally locked world. The host is the sun that
 * lights the world most, with any sun close beside it counted in its mass (a close pair is one host; a far third is not).
 * Returns { locked } or { host, days, known, year, solar, omega } in simulation time units, or null with no sun. */
export function solarDay(b, suns, lum, unknownDays = 30) {
  if (b.meta && b.meta.locked) return { locked: true };
  let host = null, bf = 0;
  for (const q of suns) if (q !== b) { const f = lum(q) / Math.max(1e-12, (q.x - b.x) ** 2 + (q.y - b.y) ** 2); if (f > bf) { bf = f; host = q; } }
  if (!host) return null;
  const d = Math.hypot(host.x - b.x, host.y - b.y);
  let M = b.m; for (const q of suns) if (q !== b && Math.hypot(q.x - b.x, q.y - b.y) < 3 * d) M += q.m;
  const year = 2 * Math.PI * Math.sqrt(d * d * d / M), known = !!(b.meta && b.meta.days), days = known ? b.meta.days : unknownDays, solar = year / days;
  return { locked: false, host: host.id, days, known, year, solar, omega: 2 * Math.PI / solar + 2 * Math.PI / year };   // sidereal: prograde, one extra turn a year
}

/* The look direction of the observer's camera, from azimuth and altitude, in the observer's frame [east, north, up]. */
export const lookVector = (az, alt) => [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)];

/* The look-around state: a heading and a tilt of the head with a little inertia, and a field of view that zooms. */
export class SkyLook {
  constructor() { this.az = 0; this.alt = 12 * DEG; this.fov = 70; this.vaz = 0; this.valt = 0; this.goal = null; }
  /* Dragging grabs the sky: the point under the finger stays under it. degPerPx is the view's angle per pixel. */
  drag(dx, dy, degPerPx) { this.goal = null; this.vaz = this.valt = 0; this.az -= dx * degPerPx * DEG; this.alt = clamp(this.alt + dy * degPerPx * DEG, -30 * DEG, 88 * DEG); }
  fling(vx, vy, degPerPx) { this.vaz = -vx * degPerPx * DEG; this.valt = vy * degPerPx * DEG; }
  zoom(factor) { this.fov = clamp(this.fov * factor, 12, 100); }
  /* turn the head by an angle at once, as held keys do, within the same limits as a drag */
  turnBy(dAz, dAlt) { this.goal = null; this.vaz = this.valt = 0; this.az += dAz; this.alt = clamp(this.alt + dAlt, -30 * DEG, 88 * DEG); }
  /* turn smoothly to face a point of the sky */
  face(az, alt) { this.goal = { az, alt: clamp(alt, -10 * DEG, 80 * DEG) }; this.vaz = this.valt = 0; }
  update(dt, reduced) {
    if (reduced) this.vaz = this.valt = 0;
    if (this.goal) {
      const k = reduced ? 1 : 1 - Math.exp(-dt * 5);
      let d = this.goal.az - this.az; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      this.az += d * k; this.alt += (this.goal.alt - this.alt) * k;
      if (Math.abs(d) + Math.abs(this.goal.alt - this.alt) < 1e-4) this.goal = null;
      return true;
    }
    if (!this.vaz && !this.valt) return false;
    this.az += this.vaz * dt; this.alt = clamp(this.alt + this.valt * dt, -30 * DEG, 88 * DEG);
    const d = Math.exp(-dt * 3.2); this.vaz *= d; this.valt *= d;
    if (Math.abs(this.vaz) + Math.abs(this.valt) < 1e-3) this.vaz = this.valt = 0;
    return true;
  }
}

/* Where a phone held up to the sky is looking, from its orientation event (degrees, W3C convention: alpha about the
 * vertical, then beta about the phone's width, then gamma about its length). The camera looks out of the back of the
 * screen, along the phone's -z, which no screen rotation changes. Returns the heading (radians, clockwise from the
 * reference alpha measures from, which need not be north) and the altitude above the horizon. */
export function phoneLook(alpha, beta, gamma) {
  const a = alpha * DEG, b = beta * DEG, g = gamma * DEG;
  const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b), sg = Math.sin(g), cg = Math.cos(g);
  const x = -sg * ca - cg * sb * sa, y = -sg * sa + cg * sb * ca, z = -cg * cb;   // east, north, up
  return { az: Math.atan2(x, y), alt: Math.asin(clamp(z, -1, 1)) };
}

/* The ground underfoot: two tiles and how far between them, and the glow mask for the one that can glow. The world's
 * map from space decides the kind of ground; the climate (0 frozen, 1-3 liveable, 4 burning) walks it toward ice or
 * scorched rock. f: { surface (the map's name), climate, gas, moon }. */
const LADDER = ['v5/ground-snow', 'v5/ground-grassland', 'v5/ground-grassland', 'v5/ground-desert', 'v5/ground-scorched'];
const SCORCHED = 'v5/ground-scorched', LAVA = 'v6/ground-lava';
export const GLOW_OF = { [SCORCHED]: 'v5/ground-scorched-glow', [LAVA]: 'v6/ground-lava-glow' };
export function groundTiles(f) {
  const c = clamp(f.climate, 0, 4), one = t => [t, t, 0];
  /* a world of its own kind: ice below the liveable range, scorched rock past it */
  const own = (t, cold = 'v5/ground-snow') => (c < 1 ? [cold, t, c] : c > 3.5 ? [t, SCORCHED, (c - 3.5) * 2] : one(t));
  if (f.gas) return one('v5/ground-cloudtops');
  switch (f.surface) {
    case 'v5/planet-lava': return one(LAVA);
    case 'v5/planet-barren': case 'moon-surface': return one('v5/ground-regolith');
    case 'v5/moon-icy': return one(f.moon ? 'v6/ground-ice-lineae' : 'v6/ground-blue-ice');   // airless ice: no wind to shape snow
    case 'v5/planet-eyeball': return own('v6/ground-ice-margin', 'v6/ground-blue-ice');   // the ring of shore and broken ice round the sunlit sea
    case 'v5/planet-ocean': return own('v6/ground-shore');
    case 'v5/planet-arid': return own('v6/ground-hardpan');
  }
  const i = Math.min(3, Math.floor(c));
  return [LADDER[i], LADDER[i + 1], c - i];
}
