# Grass & Light

A shader-level reconstruction of the grass and lighting from Lusion's
[My Little Storybook](https://exp-my-little-storybook.lusion.co/), rebuilt on our own
hill — no river, plus the site's flowers and insects.

## Run it

```bash
npx serve -l 5188 .
```

Then open <http://localhost:5188>. It must be served over HTTP; opening `index.html`
from the filesystem will fail on ES modules and `fetch`.

| input | |
|---|---|
| drag | look around |
| scroll | dolly |
| move cursor | part the grass |
| `G` / `O` | export the hill as .glb / .obj |
| `R` | reset the framing |
| `H` | hide the overlay |

---

## How the look actually works

**There is not a single light in the scene.** That is the whole trick, and everything
else follows from it.

1. **Albedo comes from one projected map.** Ground and every blade sample the same
   colour texture through `worldPosition.xz / 10.0 + 0.5`. Grass and ground therefore
   can never disagree about the colour of a spot.
2. **"Lighting" is an environment lookup.** `sampleSky(dir)` reads an equirectangular
   sky texture. Diffuse and specular are both just directional samples of it. The only
   directional term on the grass is a ±5% wrap along a hard-coded sun vector
   `vec3(0.5733)`.
3. **Fog is an SDF, not a depth fade.** `applyFog` colours a fragment with the sky *in
   the direction you are looking at it*, so distance dissolves into exactly the right
   part of the sky. The amount comes from a 2D rounded-box SDF on the xz plane — so the
   diorama fades at the edges of its stage no matter where the camera is. This detail
   drives the whole composition; see below.
4. **The beauty pass is nearly black.** Nothing above converts to gamma. Sampling the
   render target mid-frame gives about `rgb(25, 40, 0)` in the meadow.
5. **The grade is what makes it daylight.** A bloom whose strength is weighted by
   `1 - luma` (so highlights bleed *into* shadows instead of clipping), then a
   colour-dodge tint of `#72b4c9` at 0.203. Dividing by `1 - tint` lifts green ~3.4× and
   blue ~4.7× at once — brightening and cooling in a single operation. A near-black
   beauty pass comes out as roughly `rgb(53,108,56)`.
6. **All motion is one noise lookup.** A 4D simplex *gradient* per vertex gives a smooth
   3D wind vector that already varies over time on its 4th axis. Weighted by
   `yRatio²`, so blade roots stay pinned and tips accelerate.

### The fog dictates the framing

`fog = clamp(sdRoundedBox(xz, (2.5, 2.5), 1.0) - 1.5, 0, 1)`

The readable stage is only about `|x|, |z| < 3.5`, fully sky by 5. The original's own
camera anchors sat as far out as `z = 6.5` — which puts **54% fog on the foreground**
and turns the meadow milky. Our shot sits at `z = 3.58`, inside the clean core. If you
move the camera and the greens go pale and washed out, this is why.

It also caps how wide the composition can be: at fov 30 the frame spans only ~4.7 units
at the crest distance, and you cannot back off to widen it. Matching the reference's
apparent hill spread 1:1 would need the camera at `z ≈ 6.8`, deep in the fog — so the
mounds are scaled to fit the core instead.

---

## Matching the reference

`Reference/photo_*.jpg` is a shot of the original site: two mounds with a saddle, seen
from down in the grass. Two things were fitted to it.

**Silhouette.** Two commands. The first measures the target image into
`tools/reference-metrics.json`; the second traces the same quantity out of our scene —
cast a fan of rays, walk each along the ground, keep the highest point per frame
column — and hill-climbs the mound and camera parameters against it.

```bash
python tools/measure_reference.py Reference/your-image.jpg --exclude-x 0.72 1.0
```

```bash
node tools/fit-hill.mjs --eye=1.7 --setback=1.1
```

`--exclude-x` drops columns occupied by something that is neither grass nor sky (a
foreground building, say). Without it they read as a skyline spike and drag the fit
sideways. Excluded columns come through as `null` and are skipped when scoring.

To check the result, `window.grassStudy.measure()` renders at the reference's own
resolution and prints both sets of metrics side by side. Matching the resolution is not
cosmetic: edge frequency counts luminance sign changes per unit frame width, so a
larger render resolves neighbouring blades that a smaller one blurs together, and
reports more edges for identical geometry.

> The fitter projects through a real `THREE.PerspectiveCamera`. An earlier version
> linearised the pitch as `viewY = worldY - camY + pitch * distance`, which is fine near
> zero but accumulates error with pitch *and* distance — at the ~10° pitch this shot
> wants, it was off by `pitch × 8 ≈ 1.4` units on the far samples. It converged to a
> confident 0.016 while the render measured 0.042, because the two were not projecting
> the same scene. If fit and render ever disagree, suspect the projection first.

Mean skyline error is ~0.04 of frame height — which is the metric's noise floor, since
animated grass tips define the skyline and it moves ±0.012 frame to frame. Three details
matter:

- Eye height is *pinned* rather than fitted. Matching a skyline is degenerate — low
  camera with low hills looks identical to high camera with tall hills — and the
  unconstrained solution chose an eye at 0.50, below the flowers (0.41–0.51 tall), which
  buried the foreground in them.
- The fitter traces bare terrain, but the horizon you actually see is terrain *plus* the
  grass standing on it, so camera pitch needs a manual nudge afterwards.
- `MIN_RIGHT_SETBACK` holds the right mound behind the left one, so it reads as the
  further of the two. It currently sits 27% further from the camera.

### Getting the scale right

The first version had grass that read too large against the landscape. Two measurements
located the actual cause:

| measurement | mine | reference |
|---|---|---|
| blade edge frequency (edges per frame width, horizontal scanlines) | 0.38 | 0.37 |
| skyline raggedness (detrended std of topmost grass pixel) | 0.021 | 0.058 |

Blade *width* already matched — so blades were never too thick. But foreground grass
reading too large while distant grass read too small is a depth-ratio symptom, not a
size one: foreground angular size goes as `blade / eyeHeight`, distant as
`blade / distance`. Only `distance / eyeHeight` being too small pushes both the wrong
way at once — the hills sat too close for how low the camera was.

The fix was to raise the eye from 0.85 to 1.7 and re-fit, letting the mounds move to
hold the same silhouette. Blade size was left alone. Raggedness went 0.021 → 0.040.

**Colour.** Rendering this shot through all six of the original's grade presets and
scoring each against the reference's grass region picked the third, not the showy
opening one: the opening grade's blue floor alone (`tintB × tintOpacity` = 0.265, i.e.
rgb 68, added unconditionally by the `screen` term) already exceeds the reference's
measured blue of 54, so it cannot produce this image.

The albedo palette was then fitted so the *rendered* result matches, not the source
texture — green ×1.6, red ×0.8 against grass.jpg's percentiles. The grade is not a
neutral operator: colour-dodge divides red by `1 - 0.447` but green by `1 - 0.706`, so
feeding it the source palette verbatim came out too red and too dark. Measured over the
grass region the result is within 9 (summed RGB) of the reference, down from 43.

---

## What is original, what is ours

**Lifted from the site's bundle, verbatim:** every GLSL shader — instanced grass, plants,
terrain, sky, the fog/env chunk, the interaction-field sim, bloom high-pass / blur /
composite, and the final grade. Plus the blade mesh, the sculpted tuft mesh, the flower
atlas, the insect sprite sheets, the sky env map, the noise and rock textures, and the
grade constants.

**Ours:** the hill, all scatter and placement, the camera framing, the baked terrain
maps, and the plumbing.

**Deliberately left out:** the river and its water plants, the birds and storybook
scripting, audio, UI, and the bokeh depth-of-field pass.

### Three things that could not be reused

| what | why | what happens instead |
|---|---|---|
| `grass_placement.buf` | its 48 768 points follow the old terrain and leave a bald river channel through the stage | jittered-grid scatter, rejected on slope / noise patches / fog rim |
| `grass.jpg`, `terrain_ao.jpg`, `terrain_info_*` | the river is literally painted into them | baked at load from the hill's own slope and a horizon-AO pass over a height raster |
| `hero_grass.buf` index buffer | its `class` attribute is *not* a clean partition — 401 of 4366 triangles bridge two neighbouring tufts, which were adjacent on the original bank. Scattering the tufts apart stretches those into a huge dark sliver across the map. | those triangles are dropped; each of the 462 tufts is then re-seated, yawed and rescaled independently, and the whole block is repeated 3× for coverage |

---

## Sculpting the hill in Blender

The hill is the one asset worth doing by hand, so it round-trips.

1. Press **`G`** (or *Export .glb*). You get a 200 × 200 quad grid over the stage —
   dense enough to sculpt directly.
2. Sculpt it in Blender. Keep to these rules:
   - **Y up, Z forward** — Blender's glTF exporter default; don't override it.
   - **Stay inside a 10 × 10 unit footprint centred on the origin.** The shaders derive
     their UV as `worldPosition.xz / 10.0 + 0.5`; anything outside samples clamped edge
     pixels.
   - **Keep heights within roughly ±1 unit.** Blades are only 0.08–0.30 tall and that
     proportion is what sells the scale.
   - **Let the rim fall away** past `|x|` or `|z| ≈ 3.5` — the fog dissolves the ground
     out there, and a hard edge reads as a cut.
   - One mesh, normals exported, modifiers applied.
3. Save as `assets/models/terrain_custom.glb` and reload.

It is picked up automatically. Grass, tufts, flowers and insects all re-seat onto the new
surface, and the rock / AO / albedo maps are re-baked from its slopes — because
everything goes through `TerrainSurface`, a downward-ray sampler over raw triangles
rather than a height formula.

> Until that file exists, every load logs one `404` for `terrain_custom.glb` in the
> console. That is the probe for it, and it is caught — not a bug.

---

## Layout

```
src/
  main.js            scene assembly and frame loop
  shot.js            the one camera framing + grade constants + insect placements
  HillGeometry.js    procedural hill (all parameters at the top)
  TerrainSurface.js  bucketed downward-ray sampler — works on any mesh
  TerrainMaps.js     bakes grass albedo, rock mask and AO from the hill's slopes
  Scatter.js         jittered-grid scatter + orient-to-normal
  Grass.js           instanced blades + re-seated sculpted tufts
  Flowers.js         instanced billboards over the 5-cell atlas
  Insects.js         sprite-sheet bee / dragonfly / fly
  TerrainIO.js       .glb / .obj export, custom-hill import
  CameraRig.js       mouse-look about a pivot, free look, handheld shake
  Postprocessing.js  bloom + final grade
  BufLoader.js       decoder for the site's packed .buf container
  glsl/              the extracted shaders
assets/_original/    original assets this study no longer loads (see its README)
tools/fit-hill.mjs   fits hill + camera to Reference/ by skyline matching
Reference/           the target photograph
```

`window.grassStudy` is exposed for poking at things: `step(dt)` drives one frame by
hand, `sampleBeauty(x, y)` reads the ungraded pass, `sampleField(x, z)` reads the
interaction field, `exportGLB()` / `exportOBJ()`, and `hill` holds the terrain
parameters.

## Tuning

- **Hill shape** — `HILL_DEFAULTS` in `src/HillGeometry.js`: a list of mounds (position,
  height, elliptical radii, falloff) plus noise amplitudes and rim drop. Mounds combine
  with `max()`, not a sum — adding them fills the saddle in with the overlap of the two
  falloffs and flattens the notch that makes the silhouette read as two hills. Re-run
  `node tools/fit-hill.mjs` after changing the reference.
- **Density** — `bladeCount`, `flowerCount` and `tuftCopies` in `src/Grass.js` /
  `src/Flowers.js`. The counts are *ceilings*: slope/patch/rim rejection discards most
  candidates, so ask for roughly 2.5× what you want. The defaults give ~108k blades,
  1386 tufts and ~470 flowers.
- **The look** — `SHOT.grade` in `src/shot.js`. `tintColorHex` and `tintOpacity` move
  the image furthest; `bloomThreshold` decides how much of the grass blooms.

---

Assets and shaders belong to [Lusion](https://lusion.co/). This is a study
reconstruction, not a redistribution — don't ship it.
