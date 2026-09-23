# Three-Body

An interactive gravitational learning experience: explore orbital setups and follow a planet under three suns. The simulation runs in the browser; the server only delivers static files.

## Run locally

Use Node.js 24 LTS (Node 22 or newer is supported).

```sh
npm ci
npm test
npm run build
npm start
```

Open [localhost:3000](http://localhost:3000). Set `PORT` to change the port. `npm run dev` rebuilds once and starts the same production server; rerun it after source changes.

## Build and assets

Stars have evolving granular surfaces and small edge wisps. Planet textures move continuously through frozen, thawing, temperate, drying, and hot states, driven by the existing temperature model. Tidal debris, moon formation, impacts, and stellar swallowing follow actual event body IDs and current positions. The neutral scar layer preserves a damaged planet's climate. Labels and the existing night-side illumination remain separate from the images.

The twelve WebPs total **185,756 bytes**. Star movement uses a small atlas prepared in idle batches; no per-pixel processing runs in the animation loop. All effects pause with playback, reset with a new run or undo, and use reduced detail on slower devices. Reduced-motion preference keeps star surfaces static and limits event accents. Hidden tabs stop simulation and drawing. The visuals do not change the integration method, timestep tolerance, or climate calculations.

- `Three-Body Problem.html` contains the interface and simulation.
- `src/` contains the body rendering and event effects.
- `public/assets/bodies/` contains the twelve approved, optimized WebP assets.
- `scripts/build.mjs` creates `dist/index.html`, copies only publishable files from `src/` and `public/`, versions script URLs from their content, and creates Brotli/gzip representations and a build manifest.
- `server.mjs` serves only the built `dist/` tree, accepts GET/HEAD, revalidates stable URLs with content ETags, and exposes `/healthz`. It binds to `0.0.0.0` and the `PORT` environment variable.

The optimized assets are committed, so source artwork and Sharp are not needed to build or run the deployed site. To regenerate them locally when the original approved masters are present:

```sh
npm ci
npm run assets:optimize
npm run build
```

The optimizer expects the seven original PNGs and manifest under `output/body-assets-v2/` and five under `output/body-motion-v3/`. It performs only the approved crop, resize, and WebP compression. Planet states share one crop to keep their silhouettes aligned. Other bodies use centered crops; granulation is 128 px and debris is at most 64 px. Exact settings, source checksums, output sizes, and output checksums are recorded in `scripts/asset-build-report.json`. The original masters, preview studies, earlier audio, and local browser artifacts remain excluded from the repository and deployed image.

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

`npm test` exercises real simulation event metadata and mass/momentum conservation, effect attachment and cancellation, pause/reset/reduced motion, particle budgets, build isolation, repeatable output, compression, GET/HEAD, cache revalidation, healthchecks, malformed URLs, traversal attempts, and symlinks. GitHub Actions runs those tests, a production build, and a Docker build/healthcheck on pushes and pull requests. Browser testing is still necessary for the interactive simulation and its visual effects.
