# Three-Body

An interactive gravitational learning experience: explore orbital setups and follow a world that could support life under one, two or three suns. The simulation runs in the browser; the server only delivers static files.

## Systems

The preset menu is grouped by how many suns a world lives under. Every system below uses published masses, brightnesses and orbits (cited in each system's notes on the page), and the page follows one world in each: its temperature is computed from the light it receives, and the civilization story, eras and history run on top exactly as they do for Trisolaris.

| Group | System | Followed world | What it shows |
|---|---|---|---|
| One sun | Sun, Earth and Jupiter | Earth | Home at true scale; Jupiter's pull is a whisper |
| One sun | TRAPPIST-1 | e | Seven tidally locked worlds in 1.5 to 19 day orbits round an ultracool dwarf |
| One sun | Proxima Centauri | b | The nearest star's Earth-mass world, 11 days round a flaring red dwarf |
| One sun | Kepler-442 | b | A rocky world in the warm zone, far enough out to keep a day and night |
| Two suns | Alpha Centauri | a placed Earth-mass world 0.7 AU from B | S-type stability; A's closest pass every 80 years |
| Two suns | Kepler-47 | c | Three real planets circling a 7-day binary; c in the habitable zone |
| Three suns | Trisolaris | the planet | The novel's chaotic world, with seeded skies |
| Three suns | Gliese 667 | Cc | A real three-sun sky: C warms the world, A and B are scenery 230 AU away |

A body may carry metadata the integrator never reads: a name and label, a sun's tone and measured brightness (used instead of the mass rule), whether a world is tidally locked (it then keeps one face to the sun that lights it, in both views), and which world the page follows. The Classics group keeps the mathematical setups (Figure-eight, Moth, Lagrange's triangle, the slingshot and the rest) unchanged. `Gliese 667` frames its near sun and worlds and leaves A and B past the edge markers, since at 230 AU they add a few millionths of the planet's warmth.

## Run locally

Use Node.js 24 LTS (Node 22 or newer is supported).

```sh
npm ci
npm run check
npm start
```

Open [localhost:3000](http://localhost:3000). Set `PORT` to change the port. `npm run dev` rebuilds once and starts the same production server; rerun it after source changes.

Body labels are off by default. Enable **Customize → View → Body labels** to show letters on the sky and offscreen markers; the choice is saved in your browser. The editor, accessible names, and history still use those identifiers to distinguish bodies.

## Build and assets

Stars, planets, and moons have rotating spherical surfaces. Three generated surface maps supply terrain, lunar craters, and stellar granulation. Planet textures move continuously through frozen, thawing, temperate, drying, and hot states, driven by the existing temperature model; all states share the same geography and rotation. Tidal debris, moon formation, impacts, and stellar swallowing follow actual event body IDs and current positions. A damaged planet's scar rotates with its surface and preserves its climate. Labels, halos, and the existing night-side illumination remain separate from the rotating textures.

The fourteen WebPs total **290,634 bytes**, including **110,442 bytes** for the three new surface maps. The renderer projects 64 px frames into bounded atlases during short preparation batches, then blends cached frames without per-pixel work during drawing. The three stars share one projected atlas; the total estimated decoded image, atlas, and scratch memory is about 12.2 MiB. Original sprites remain as loading and failure fallbacks.

Rotation follows actual simulation progress, normalized by each preset's playback rate. At 1×, the planet turns in 24 seconds, the moon in 56 seconds, and the amber/cyan/coral stars in 48/56/64 seconds. These are presentation timings, not simulated physical spin periods. The 0.25×–8× controls scale rotation proportionally, including automatic close-pass slowdown and CPU throttling. Changing speed preserves phase. Short event accents retain their real-time durations so they remain legible at high speed.

All effects pause with playback, reset with a new run or undo, and use reduced detail on slower devices. Reduced-motion preference keeps surfaces static and limits event accents. Hidden tabs stop simulation and drawing. The visuals do not change the integration method, timestep tolerance, or climate calculations.

- `Three-Body Problem.html` contains the interface and simulation.
- `src/` contains the body rendering and event effects.
- `public/assets/bodies/` contains the optimized sprites and surface maps.
- `scripts/build.mjs` creates `dist/index.html`, copies only publishable files from `src/` and `public/`, versions script URLs from their content, and creates Brotli/gzip representations and a build manifest.
- `server.mjs` serves only the built `dist/` tree, accepts GET/HEAD, revalidates stable URLs with content ETags, and exposes `/healthz`. It binds to `0.0.0.0` and the `PORT` environment variable.

The optimized assets are committed, so source artwork and Sharp are not needed to build or run the deployed site. To regenerate them locally when the original approved masters are present:

```sh
npm ci
npm run assets:optimize
npm run build
```

The sprite optimizer expects the original PNGs and manifests under `output/body-assets-v2/` and `output/body-motion-v3/`. It performs only crop, resize, and WebP compression. Planet states share one crop to keep their silhouettes aligned. Other bodies use centered crops; debris is at most 64 px. The old square granulation texture is retired from the deployment. Exact settings, source checksums, output sizes, and output checksums are recorded in `scripts/asset-build-report.json`.

For the rotating surfaces, `npm run assets:rotation` resizes and compresses the three generated masters in `output/body-rotation-v4/images/` to 512×256 WebPs. The built-in image generation prompts are recorded in `scripts/rotation-asset-prompts.json`, and the compression settings and checksums are in `scripts/rotation-asset-build-report.json`. The renderer handles longitude seams, poles, climate palettes, fixed limb shading, and continuous frame blending. The original masters, preview studies, earlier audio, and local browser artifacts remain excluded from the repository and deployed image.

## 3D view

**Customize → View → 3D** (or the V key, or [/?view=3d](http://localhost:3000/?view=3d)) draws the same simulation as lit, textured spheres over the orbital plane, with a camera that turns, tilts and zooms. Everything else on the page is unchanged: the gravity core, presets, trails, climate, civilizations, captions, history, editing by touch and undo all run exactly as in the flat chart, which stays the default. The 3D view is a renderer beneath the chart, not a second page: `src/sky3d.js` receives the page's bodies, trails, sizes and colours each frame, and the chart keeps drawing its own overlays (labels, velocity arrows, the path ahead, event effects, edge markers) through the 3D projection. The orbits remain planar; only the camera moves.

The camera rig in `src/sky3d-model.js` has three modes. **Show all** frames every body and its recent trail inside the clear area of the screen, pulls back quickly when something leaves and closes in slowly, and turns very slowly while playing once the viewer has been idle for a few seconds (**Slow turn while playing** switches that off). **Follow** keeps a chosen body centred: double-tap (or double-click) a body, or pick **Follow selected** in the Camera control; zooming, by wheel or pinch, keeps following. Any zoom or Shift-drag while showing all hands the camera to the viewer, and the Camera control then shows neither choice; the **Show all** chip (or F, or a double-tap on empty sky) frames everything again. Drag turns the view with a fling (none under reduced motion), Shift-drag and a two-finger drag slide it with the plane pinned under the pointer, scroll or pinch zooms toward the pointer, the arrow keys turn and tilt, [ and ] zoom, and 1, 2, 3 jump to overhead, tilted and low angles. While the sky plays, a drag that starts on a body still turns the camera; pause to drag bodies, as in the flat chart. The rig and its fitting are plain arithmetic and are tested headlessly; the WebGL scene itself is checked by hand in a browser.

Rendering uses [three.js](https://threejs.org), the project's only runtime dependency, loaded on demand so the flat page never downloads it. Files referenced as `vendor/<name>.js` from the page or its modules are copied from the installed package at build time, never committed; the page maps the bare `three` specifier to that copy with an import map. The five vendored files add about 365 KB Brotli-compressed, fetched only when the 3D view is chosen. Suns are emissive spheres with visible granulation, limb darkening and a point light each (from a pool that never shrinks, so a merger does not recompile shaders), so worlds have a real day and night side; the light a world receives is compressed to its 0.4 power and the lit worlds alone are tone mapped, so a scorched inner world and a cold outer one both show a terminator; spheres turn on fixed, tilted axes by the same simulated-progress clock as the flat surfaces but with shorter presentation periods (9 s for the planet, 16 s for the moon and 18/22/26 s for the suns at 1×), so the turning stays visible at 0.25×; worlds keep a faint self-glow of their climate colour so they stay readable at a few pixels across, and the planet carries a thin atmosphere whose colour follows its climate. Trails are screen-width ribbons that fade toward the tail, mixed in sRGB as the flat chart's canvas mixes them. In a crowded system seen from far off, spheres shrink by the real distance to their nearest neighbour, as discs do on the flat chart. If the graphics context is lost the flat chart takes over until it returns. Both appearances are supported, reduced motion snaps the camera and stills the surfaces, and a browser without WebGL keeps the flat chart with a note. `/3d` redirects to the main page in 3D.

## Docker

```sh
docker build -t three-body .
docker run --rm -p 3000:3000 -e PORT=3000 three-body
```

The two-stage image uses Node 24, builds from committed optimized assets, and runs as the unprivileged `node` user. The runtime contains only `dist/` and `server.mjs`, with no npm packages or original master artwork.

## Deploy to Railway

1. Create a Railway service from this GitHub repository. Railway [detects and builds the Dockerfile](https://docs.railway.com/services); keep the repository root as the service root directory.
2. Keep the Dockerfile's start command, `node server.mjs`. No custom build command, database, volume, secret, or asset-generation step is needed.
3. Set the service healthcheck path to `/healthz`. The server uses Railway's injected `PORT`, as required by [Railway healthchecks](https://docs.railway.com/deployments/healthchecks).
4. Generate a public domain in the service's networking settings, deploy, and check the home page and `/healthz`.

These are deployment instructions, not a claim that a Railway service is already running. Configuration lives in the Dockerfile and service settings: Railway's current documentation says new services cannot use the deprecated [`railway.json` Config as Code](https://docs.railway.com/config-as-code). For a later project-wide configuration, use [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code).

## Checks

Run `npm run check` locally before pushing. It runs all tests and creates the production build; no GitHub Actions workflow is configured.

`npm test` exercises real simulation event metadata and mass/momentum conservation, effect attachment and cancellation, pause/reset/reduced motion, particle budgets, all playback speeds, rotation phase continuity and simulation throttling, projected surface seams, climate/scar alignment, bounded rendering caches, missing art, build isolation, repeatable output, compression, GET/HEAD, cache revalidation, healthchecks, malformed URLs, traversal attempts, and symlinks. Browser testing is still necessary for the interactive simulation and its visual effects.

To verify the deployment image locally, start Docker and use the build/run commands above. With the container running, check its health and asset delivery from another terminal:

```sh
curl --fail http://localhost:3000/healthz
curl --fail --head http://localhost:3000/
curl --fail --output /dev/null http://localhost:3000/assets/bodies/star-amber.webp
```
