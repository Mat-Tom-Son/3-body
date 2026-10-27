/* Which surface map a body wears, for the flat chart and the 3D view alike, so the two always agree. A plain script that
 * sets window.Surfaces; it reads only the body and two numbers the caller already has, and holds no state.
 *
 * - A sun by its mass: a red dwarf (under 0.45 Suns) blotchy and spotted, an orange dwarf (to 0.93, Alpha Centauri B's
 *   class) quieter, others the Sun's fine granulation. `mean` is where the 3D star shader centres the map's grey.
 * - A world by what it is: one past the radius valley (wider than two Earths) is banded gas; a rocky world can name its
 *   surface in meta.surface (Earth, Kepler-442 b's desert, a placed ocean world); one locked to its sun is an eyeball
 *   where the climate's limits call its light liveable, bare rock where they call it scorched (over 320 K), ice where
 *   frozen (under 235 K); over about 900 K (a hundred times Earth's light) rock melts.
 *
 * flux: the light the body receives, in Earth's; radius: its radius in Earth radii (published, or from its mass). */
(() => {
  'use strict';
  const STARS = { m: ['v5/star-m-dwarf', 0.254], k: ['v5/star-k-dwarf', 0.317], g: ['star-surface', 0.22] };
  const NAMED = { earth: 'planet-surface', ocean: 'v5/planet-ocean', arid: 'v5/planet-arid', terran: 'v5/planet-terran-b', eyeball: 'v5/planet-eyeball',
    barren: 'v5/planet-barren', lava: 'v5/planet-lava', icy: 'v5/moon-icy' };
  const AIRLESS = new Set(['barren', 'lava', 'icy']);
  const HOT = Math.pow(320 / 288, 4), COLD = Math.pow(235 / 288, 4);   // the page's climate limits (CLIMATE.HOT, COLD) as light received
  const kindOf = b => (b.m >= 0.05 && b.kind !== 'planet' && b.kind !== 'moon' ? 'star' : b.kind === 'moon' ? 'moon' : b.kind === 'planet' ? 'planet' : 'giant');
  function surfaceOf(b, flux, radius) {
    const kind = kindOf(b);
    if (kind === 'star') { const [name, mean] = STARS[b.m < 0.45 ? 'm' : b.m < 0.93 ? 'k' : 'g']; return { name, mean, star: true }; }
    if (kind === 'moon') return { name: flux < COLD ? 'v5/moon-icy' : 'moon-surface', airless: true, moon: true };
    if (radius > 2) return { name: radius >= 6 ? 'v5/giant-jovian' : 'v5/giant-neptunian', gas: true };
    const named = b.meta && b.meta.surface;
    if (named && NAMED[named]) return { name: NAMED[named], airless: AIRLESS.has(named), lava: named === 'lava' };
    if (flux > 100) return { name: NAMED.lava, airless: true, lava: true };
    if (b.meta && b.meta.locked) return flux > HOT ? { name: NAMED.barren, airless: true } : flux >= COLD ? { name: NAMED.eyeball } : { name: NAMED.icy, airless: true };
    return { name: NAMED.terran };
  }
  window.Surfaces = { surfaceOf, kindOf };
})();
