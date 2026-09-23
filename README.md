# Three-Body

An interactive gravitational learning experience: explore orbital setups and follow a planet under three suns. The simulation runs in the browser; the server only delivers static files.

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
