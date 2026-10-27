/* Pure helpers for the 3D view: the camera rig, view fitting, body tints and spin. No DOM, no three.js and no
 * simulation state, so every rule here is checked headlessly. The physics is untouched: this file only reads positions.
 * Scene coordinates: the orbital plane is the floor, x stays x, the simulation's y becomes -z, and up is +y. */
export const TAU = Math.PI * 2;
/* Seconds per turn at 1× playback. Like the flat page these follow simulated progress, so speed changes scale them, but
 * a sphere shows its whole face turning, and these shorter periods keep that motion visible even at 0.25×. */
export const SPIN_PERIODS = { planet: 9, moon: 16, giant: 12, amber: 18, cyan: 22, coral: 26 };   // giant: an untagged world, such as the Planet and moon preset's planet
export const TONES = ['amber', 'cyan', 'coral'];
export const STAR_PHASE = { amber: 0.25, cyan: 2.3, coral: 4.65 };
export const toneOf = id => TONES[((id % 3) + 3) % 3];
export const spinAngle = (spinTime, period) => TAU * (spinTime / period - Math.floor(spinTime / period));
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ease = (dt, rate) => 1 - Math.exp(-dt * rate);

/* How strongly the planet's map is washed toward ice or scorched earth, from the flat page's climate index (0 frozen,
 * 1 thawing, 2 temperate, 3 warming, 4 hot), which that page already smooths for presentation. */
const ICE = [0.86, 0.92, 1], DUST = [0.96, 0.72, 0.42], EMBER = [0.78, 0.33, 0.16];
const mix3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
export function climateTint(index) {
  const c = clamp(index, 0, 4);
  if (c <= 2) return { rgb: ICE, amount: 0.8 * (2 - c) / 2 };
  if (c <= 3) return { rgb: DUST, amount: 0.4 * (c - 2) };
  return { rgb: mix3(DUST, EMBER, c - 3), amount: 0.4 + 0.4 * (c - 3) };
}
/* The atmosphere's colour and strength by the same index: thin and white when frozen, blue when living, orange when burning. */
export function atmosphereTint(index) {
  const c = clamp(index, 0, 4);
  if (c <= 2) return { rgb: mix3([0.85, 0.9, 1], [0.45, 0.75, 1], c / 2), strength: 0.55 + 0.35 * c / 2 };
  return { rgb: mix3([0.45, 0.75, 1], [1, 0.5, 0.2], (c - 2) / 2), strength: 0.9 + 0.3 * (c - 2) / 2 };
}

/* Camera basis vectors for an orbit camera at polar angle phi (0 overhead), heading theta, looking at its target. */
export function basisOf(theta, phi) {
  const sp = Math.sin(phi), cp = Math.cos(phi), st = Math.sin(theta), ct = Math.cos(theta);
  const forward = [-sp * st, -cp, -sp * ct];                         // from the camera toward the target
  const right = [ct, 0, -st];                                        // cross(forward, up) normalised, with up = +y
  const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  return { forward, right, up };
}
export const cameraOffset = (theta, phi, dist) => [dist * Math.sin(phi) * Math.sin(theta), dist * Math.cos(phi), dist * Math.sin(phi) * Math.cos(theta)];

/* The camera distance that keeps every point inside the view with a margin, for a camera that looks along `forward` at the
 * target the points are measured from. Points are [x, y, z] in scene units relative to the target. tanH and tanV are the
 * half-angle tangents of the usable part of the view. */
export function fitDistance(points, { right, up, forward, tanH, tanV, margin = 1.15, min = 0.5 }) {
  let need = min;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const q of points) {
    const s = dot(q, forward), u = Math.abs(dot(q, right)), v = Math.abs(dot(q, up));
    need = Math.max(need, u * margin / tanH - s, v * margin / tanV - s);
  }
  return need;
}

/* The orbit camera: where it looks (a point on the plane), how far away it is, and from what heading and tilt. Each value
 * has a goal and a current, eased value, so that automatic framing, follow mode and the user's own moves all blend. */
export class CameraRig {
  constructor() {
    this.cur = { theta: -0.55, phi: 0.95, dist: 10, tx: 0, tz: 0 };
    this.goal = { theta: -0.55, phi: 0.95, dist: 10, tx: 0, tz: 0 };
    this.mode = 'overview';          // 'overview' frames everything, 'follow' tracks one body, 'manual' holds still
    this.followId = -1;
    this.followDist = null;          // the distance the viewer chose while following; null means a sensible default
    this.followBlend = 1;            // 0 just after follow begins, 1 once the target is locked to the body
    this.vTheta = 0; this.vPhi = 0;  // fling inertia, radians per second
    this.vtx = 0; this.vtz = 0;      // the target's smoothed velocity, so a drifting group is tracked without lag
    this.prevGoal = null;
    this.cut = true;                 // snap to the next goal instead of easing to it
    this.idle = 0;                   // seconds since the viewer last touched the camera
    this.drift = true;               // a slow turn while playing and idle
    this.minPhi = 0.04; this.maxPhi = Math.PI / 2 - 0.06;   // never below the plane, never exactly overhead
  }
  touch() { this.idle = 0; }
  setMode(mode, id = -1) {
    if (mode === this.mode && id === this.followId) return;
    this.mode = mode; this.followId = id; this.prevGoal = null; this.vtx = this.vtz = 0;
    if (mode === 'follow') { this.followDist = null; this.followBlend = 0; }
  }
  cutNext() { this.cut = true; this.vTheta = this.vPhi = 0; this.vtx = this.vtz = 0; this.prevGoal = null; }
  settle() { this.vtx = this.vtz = 0; this.prevGoal = null; }   // a new run from the same place: forget the old motion, keep the view
  /* The viewer turns the camera by dragging: dx, dy in pixels, h the view height. Never changes the mode. */
  orbit(dx, dy, h) {
    const k = TAU / Math.max(1, h);
    this.goal.theta -= dx * k * 0.75; this.goal.phi = clamp(this.goal.phi + dy * k * 0.75, this.minPhi, this.maxPhi);
    this.cur.theta = this.goal.theta; this.cur.phi = this.goal.phi;
    this.vTheta = this.vPhi = 0; this.touch();
  }
  fling(vx, vy, h) { const k = TAU / Math.max(1, h) * 0.75; this.vTheta = -vx * k; this.vPhi = vy * k; this.touch(); }
  /* Back to the starting heading and tilt by the shortest turn, smoothly. Never changes the mode. */
  resetAngle() {
    const home = -0.55, k = Math.round((this.goal.theta - home) / TAU);
    this.goal.theta = home + k * TAU; this.goal.phi = 0.95; this.vTheta = this.vPhi = 0; this.touch();
  }
  /* Turn the heading at once by an angle, as two twisting fingers do. Never changes the mode. */
  turn(dTheta) { this.goal.theta += dTheta; this.cur.theta = this.goal.theta; this.vTheta = 0; this.touch(); }
  /* A smooth turn by whole steps, for keys and buttons. */
  nudge(dTheta, dPhi) { this.goal.theta += dTheta; this.goal.phi = clamp(this.goal.phi + dPhi, this.minPhi, this.maxPhi); this.vTheta = this.vPhi = 0; this.touch(); }
  setTilt(phi) { this.goal.phi = clamp(phi, this.minPhi, this.maxPhi); this.vPhi = 0; this.touch(); }
  /* Zoom by a factor, toward a point on the plane when one is given. Zooming leaves overview for manual; following keeps following. */
  dolly(factor, at) {
    factor = clamp(factor, 0.2, 5);
    this.goal.dist = clamp(this.goal.dist * factor, 0.01, 5000); this.cur.dist = this.goal.dist;
    if (at && this.mode !== 'follow') {
      this.goal.tx += (at[0] - this.goal.tx) * (1 - factor); this.goal.tz += (at[1] - this.goal.tz) * (1 - factor);
      this.cur.tx = this.goal.tx; this.cur.tz = this.goal.tz;
    }
    if (this.mode === 'overview') this.setMode('manual');
    if (this.mode === 'follow') this.followDist = this.goal.dist;
    this.touch();
  }
  /* Slide the target across the plane by a screen offset (pixels), at the target's own scale. The plane is foreshortened
   * by the tilt, so a vertical move covers 1/cos(phi) as much ground as a sideways one. The page anchors the plane under
   * the finger exactly with shift(); this is the fallback when the pointer is above the horizon. */
  pan(dx, dy, pxPerWorld) {
    const { right, forward } = basisOf(this.cur.theta, this.cur.phi), f = Math.hypot(forward[0], forward[2]) || 1;
    const ax = forward[0] / f, az = forward[2] / f, w = 1 / Math.max(1e-9, pxPerWorld), wy = w / Math.max(0.2, Math.cos(this.cur.phi));
    this.shift(-dx * right[0] * w + dy * ax * wy, -dx * right[2] * w + dy * az * wy);
  }
  /* Move the target across the plane by a distance in scene units. Leaves overview for manual; following ignores it. */
  shift(dx, dz) {
    if (this.mode === 'follow') this.setMode('manual');   // sliding away from a followed body means looking elsewhere
    this.goal.tx += dx; this.goal.tz += dz; this.cur.tx = this.goal.tx; this.cur.tz = this.goal.tz;
    if (this.mode === 'overview') this.setMode('manual');
    this.touch();
  }
  /* Fly across the plane while keys are held: fwd and side from -1 to 1, toward where the camera faces and to its right.
   * The speed is in proportion to the distance, so a held key crosses about half the view each second at any zoom.
   * Like a slide, it leaves overview and follow for manual. */
  move(fwd, side, dt) {
    const { right, forward } = basisOf(this.cur.theta, this.cur.phi), f = Math.hypot(forward[0], forward[2]) || 1, v = 0.6 * this.cur.dist * dt;
    this.shift((forward[0] / f * fwd + right[0] * side) * v, (forward[2] / f * fwd + right[2] * side) * v);
    this.vtx = this.vtz = 0; this.prevGoal = null;   // the keys' own motion, not a velocity to carry on after they let go
  }
  /* One frame. env: { dt, points: [[x,z]...] to keep in view, follow: [x,z] or null, followDefault: distance, tanH, tanV,
   * minHalf: the smallest half-extent worth framing, playing, reduced, hold: true while a body is being dragged }.
   * Returns true when the picture changed. */
  update(env) {
    const { dt, cur, goal } = { dt: Math.max(0, env.dt || 0), cur: this.cur, goal: this.goal };
    this.idle += dt;
    const reduced = !!env.reduced, hold = !!env.hold;
    if (reduced) this.vTheta = this.vPhi = 0;   // reduced motion: a drag turns the camera and stops with the finger
    /* inertia from a fling, then a slow turn while nothing else is happening */
    if (this.vTheta || this.vPhi) {
      goal.theta += this.vTheta * dt; goal.phi = clamp(goal.phi + this.vPhi * dt, this.minPhi, this.maxPhi);
      const d = Math.exp(-dt * 3.2); this.vTheta *= d; this.vPhi *= d;
      if (Math.abs(this.vTheta) + Math.abs(this.vPhi) < 1e-3) this.vTheta = this.vPhi = 0;
    } else if (this.drift && this.mode === 'overview' && env.playing && !reduced && !hold && this.idle > 6) {
      goal.theta += 0.022 * dt * clamp((this.idle - 6) / 4, 0, 1);
    }
    /* where to look and from how far */
    if (!hold) {
      if (this.mode === 'overview' && env.points && env.points.length) {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [x, z] of env.points) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
        goal.tx = (x0 + x1) / 2; goal.tz = (z0 + z1) / 2;
        goal.dist = this.distanceFor(env.points, goal, env, 1);
      } else if (this.mode === 'follow' && env.follow) {
        goal.tx = env.follow[0]; goal.tz = env.follow[1];
        goal.dist = this.followDist ?? env.followDefault ?? goal.dist;
      }
    }
    /* easing: angles always, target with velocity feed-forward, distance in log space (quick to pull back, slow to close in) */
    let moved = false;
    if (this.cut || reduced) {
      Object.assign(cur, goal); this.cut = false; this.prevGoal = Object.assign(this.prevGoal || {}, goal); this.vtx = this.vtz = 0; moved = true;
    } else {
      const ka = ease(dt, 6), kp = ease(dt, 2.6);
      if (this.prevGoal && dt > 0 && !hold) {
        const a = ease(dt, 2.5);
        this.vtx += ((goal.tx - this.prevGoal.tx) / dt - this.vtx) * a; this.vtz += ((goal.tz - this.prevGoal.tz) / dt - this.vtz) * a;
      }
      this.prevGoal = Object.assign(this.prevGoal || {}, goal);
      const before = Object.assign(this.before || (this.before = {}), cur);
      cur.theta += (goal.theta - cur.theta) * ka; cur.phi += (goal.phi - cur.phi) * ka;
      if (!hold) {
        /* following locks onto the body once the short blend-in is over: at close range any lag would lose it */
        if (this.mode === 'follow') this.followBlend = Math.min(1, this.followBlend + dt / 0.6);
        const kt = this.mode === 'follow' ? Math.max(kp, this.followBlend) : kp;
        cur.tx += this.vtx * dt * (1 - (this.mode === 'follow' ? this.followBlend : 0)) + (goal.tx - cur.tx) * kt; cur.tz += this.vtz * dt * (1 - (this.mode === 'follow' ? this.followBlend : 0)) + (goal.tz - cur.tz) * kt;
        const out = goal.dist > cur.dist, kz = ease(dt, out ? 4 : 0.7), ls = Math.log(cur.dist), lt = Math.log(goal.dist);
        cur.dist = Math.exp(ls + (lt - ls) * kz);
      }
      moved = Math.abs(cur.theta - before.theta) + Math.abs(cur.phi - before.phi) > 1e-5 || Math.abs(Math.log(cur.dist / before.dist)) > 1e-4
        || (Math.abs(cur.tx - before.tx) + Math.abs(cur.tz - before.tz)) > 1e-4 * cur.dist;
    }
    /* whatever the easing does, nothing that is being framed may leave the view */
    if (this.mode === 'overview' && env.points && env.points.length && !hold) {
      const need = this.distanceFor(env.points, cur, env, 0.98);
      if (need > cur.dist) { cur.dist = need; moved = true; }
    }
    return moved;
  }
  /* fitDistance for points on the plane measured from `at`, without building a relative copy of every point each frame */
  distanceFor(points, at, env, marginScale) {
    const { right, up, forward } = basisOf(at.theta, at.phi), margin = 1.12 * marginScale, tanH = env.tanH, tanV = env.tanV;
    let need = 0.05;
    const fit = (x, z) => {
      const s = x * forward[0] + z * forward[2], u = Math.abs(x * right[0] + z * right[2]), v = Math.abs(x * up[0] + z * up[2]);
      need = Math.max(need, u * margin / tanH - s, v * margin / tanV - s);
    };
    for (const p of points) fit(p[0] - at.tx, p[1] - at.tz);
    const mh = env.minHalf || 0;
    if (mh) { fit(mh, 0); fit(-mh, 0); fit(0, mh); fit(0, -mh); }
    return need;
  }
}
