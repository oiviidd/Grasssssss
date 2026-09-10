/**
 * One shot, and the look it is graded with.
 *
 * The original site played a fixed list of six storybook shots; this is a single custom
 * framing of our own hill instead. The *grade*, though, is worth keeping verbatim —
 * these numbers are lifted from the original's opening scene and they are what turn an
 * almost-black beauty pass into daylight:
 *
 *   bloomAmount 3.717 with a negative radius   → the wide, soft mips dominate
 *   bloomThreshold 0.5                          → only the lit blade tips bloom
 *   tint #05c5e0 at 0.302 opacity, colour-dodge → lifts and cools everything at once
 *   vignette #0b1f23 from 0.477                 → keeps the corners from going milky
 *
 * The camera sits low and slightly off-axis so the near grass crosses the frame and the
 * hill's shoulder breaks the horizon. Distance 3 puts the mouse-look pivot near the
 * crown, which makes the parallax swing around the subject rather than sliding past it.
 */
export const SHOT = {
	name: 'Our hill',

	// Placed inside the fog's clean core. The fog is an SDF around the origin, not a depth
	// fade — `clamp(sdRoundedBox(xz, (2.5,2.5), 1) - 1.5, 0, 1)` — so ground past roughly
	// |x|,|z| > 3.5 is already dissolving into sky. Framing from further out (the original's
	// own anchors sat at z ~ 6.5) puts 50%+ fog on the *foreground* and turns the whole
	// meadow milky. Everything worth seeing has to live inside that box.
	//
	// Fitted alongside the hill by tools/fit-hill.mjs. Eye height is pinned there rather
	// than fitted, because matching a skyline alone is degenerate — low camera with low
	// hills looks identical to high camera with tall hills.
	//
	// Pinned at 0.5, down in the grass. A higher eye also fits the skyline (1.4 scores
	// 0.0053 against this 0.0071) but produces the wrong *perspective*: measuring edge
	// frequency band by band down the frame, the reference peaks mid-frame and then
	// coarsens toward the bottom (0.514 → 0.419) as near grass magnifies, while the high
	// camera stayed flat (0.508 → 0.516). Grass then reads as too tall at every blade
	// size, because the fault is the depth ratio, not the geometry.
	//
	// fov is vertical in three, so this vertical framing holds at any window aspect; a wider
	// window simply reveals more to either side.
	camera: {
		position: [ - 0.430, - 0.050, 3.097 ],
		rotation: [ 0.015, 0, 0 ],
		cameraDistance: 3
	},

	// The original's third scene grade, picked by rendering this shot through all six of
	// its presets and scoring each against the reference. The opening scene's grade
	// (tint #05c5e0 at 0.302) is the showier one, but its blue floor alone — tintB ×
	// tintOpacity, added unconditionally by the `screen` term — is 0.265, i.e. rgb 68,
	// which is above the reference's measured blue of 54. It cannot produce this image.
	grade: {
		bloomAmount: 2.10888,
		bloomRadius: - 0.04369,
		bloomThreshold: 0.24137,
		bloomSmoothWidth: 1.00155,
		haloWidth: 0.93376,
		haloRGBShift: 0.03,
		haloStrength: 0.3,
		haloMaskInner: 0.8255,
		haloMaskOuter: 1,

		vignetteFrom: 0.47665,
		vignetteTo: 1.17146,
		vignetteColorHex: 0x0b1f23,

		saturation: 1,
		contrast: 0,
		brightness: 1,

		tintColorHex: 0x72b4c9,
		tintOpacity: 0.203,

		cameraLookStrength: 0.025,
		cameraShakeStrength: 0.30144
	}
};

/**
 * Grass tuning, held here rather than buried in Grass.js because it is matched to the
 * reference image and gets re-fitted whenever that changes.
 *
 * Verify with `window.grassStudy.measure()`, which renders at the reference's own
 * resolution and prints both sets of metrics side by side.
 *
 *   bladeCount       a ceiling — slope/patch/rim rejection discards most candidates
 *   bladeWidthScale  narrows the blade; drives edge frequency
 *   bladeHeightScale shortens the blade; keeps width and height independent
 *   tuftInstances    total tuft placements — works the same whether the source mesh
 *                    holds 462 tufts or a single imported clump
 *   tuftScale        height multiplier on those tufts; drives skyline raggedness
 *   flowerCount      ceiling, same rejection applies
 *   flowerScale      height multiplier on the billboards
 */
export const GRASS = {
	bladeCount: 160000,
	bladeWidthScale: 0.42,
	bladeHeightScale: 0.80,
	tuftInstances: 2310,
	tuftScale: 1.0,
	flowerCount: 1100,
	flowerScale: 0.5
};

/*
 * Two findings worth keeping, both counter-intuitive:
 *
 * Density is not the lever for fineness. Raising bladeCount from 130k to 200k *lowered*
 * edge frequency (0.423 → 0.413) — past a point extra blades overlap into solid mass
 * instead of adding resolvable silhouettes. Narrowing the blade is what works.
 *
 * The two metrics pull against each other. Narrow blades raise edge frequency but lower
 * raggedness, because thin tips stop registering above the green threshold; and adding
 * tuft *copies* makes the canopy more uniform rather than more ragged. The reference
 * achieves both because its fine carpet and its tall wisps are separate elements — so
 * blade width drives one and tuft height drives the other, independently.
 *
 * Width and height must move separately. instanceSize scales the blade uniformly, so
 * narrowing alone made blades 2.4x more slender — they read as tall thin spikes rather
 * than as smaller grass. bladeHeightScale shortens them back. There is a floor: below
 * about 0.8 the blades stop resolving and edge frequency collapses (0.47 -> 0.28 by 0.45),
 * so "smaller grass" past that point has to come from the camera, not the geometry.
 */

/**
 * Fog shape — the strongest control over how hard the ground's silhouette reads.
 *
 * `boxSize` and `radius` describe the rounded box on the xz plane that stays clear;
 * ground beyond it fades to sky over `range`, starting `start` past the box. These were
 * hard-coded in the original as 2.5 / 1.0 / 1.5 / 1.0.
 *
 * With a low camera the horizon is the furthest visible ground, which sits exactly where
 * the fog has dissolved it — so a small box smears the ground edge over a wide band. Grass
 * normally hides this by breaking the silhouette; with the grass turned off it is obvious.
 * A larger box or a shorter range gives a cleaner edge, at the cost of the diorama
 * feeling less like it floats.
 */
export const FOG = {
	boxSize: 3.6,
	radius: 1.0,
	start: 1.9,
	range: 0.7,

	// The box is offset from the terrain (which centres on z = -2), and that is what makes
	// the horizon dissolve: the ground reaches z = -7 while the box fades out from 5.5, so
	// the far rim melts into sky and the foreground stays clear. Centring it on the terrain
	// zeroes the term everywhere.
	centre: [ 0, 0 ],

	// Aerial perspective, added because the stage SDF above is position-based: two hills at
	// different depths but similar distance from the box centre took identical fog and
	// merged into one silhouette. Held well below 1 — the far hill should read as further
	// away, not disappear.
	// 0.35 measured against this shot: it triples the colour distance between the two hills
	// (26 -> 80 summed RGB) while the foreground and the near hill stay pixel-identical.
	// 0.45 separates harder but washes the far grass out; 0.25 barely reads.
	hazeStart: 4.5,
	hazeRange: 6.5,
	hazeAmount: 0.35
};

/**
 * The distant snow-capped cone, and how it is framed.
 *
 * Two kinds of number here, and the distinction matters:
 *
 *   world  — distance and baseY. These are what make it read as *far away*: the parallax
 *            against the camera-locked sky, and how much of it the meadow's ridge hides.
 *            They never change with the viewport.
 *   frame  — anchorX and scale, interpolated between a wide and a narrow layout. fov in
 *            three is vertical, so a portrait phone crops the sides away; a cone pinned to
 *            a world x simply leaves the shot. anchorX is NDC (-1 left edge, +1 right).
 *
 * distance is held under the sky sphere's radius of 15. That sphere is pinned to the
 * camera and writes depth, so anything past it is occluded by the sky itself.
 */
export const MOUNTAIN = {
	distance: 12,

	// The *summit* height, not the base. Shrinking the cone for a narrow viewport used to
	// drop its peak below the meadow's ridge and hide it completely; pinning the summit
	// means scale only narrows the silhouette, and the peak clears the grass by the same
	// margin on every screen. The base goes wherever it must — the meadow covers it.
	summitY: 2.5,

	// Tuned for the artist's model, assets/models/mountain_custom.glb, which loads at startup.
	// Its texture has the lighting baked in, so it is drawn unlit at an ordinary exposure
	// (measured: 1 puts the snow at [227,241,250] against the reference's [222,231,240]), and
	// fitted to the blockout's height.
	modelScale: 0.98,
	screenX: 0,
	exposure: 1,
	unlit: 1,

	// Flat distance haze, plus a separate bank of mist around the foot: the base dissolves
	// while the upper flanks keep their colour. Flat haze alone can only wash the cone evenly.
	haze: 0.14,
	baseMist: 0.4,
	baseMistHeight: 0.45,

	// Framing per viewport shape. anchorX is NDC; width/height scale the cone.
	//
	// They are separate on purpose. A narrow viewport needs a narrower cone or it fills the
	// frame edge to edge — but shrinking it *uniformly* drops the summit behind the meadow's
	// ridge, and occlusion does not care about fov, so no amount of reframing brings it back.
	// Squeezing only the width keeps the peak exactly where it was and the base safely
	// hidden; the cone simply reads as a steeper volcano on a phone.
	//
	// The reference frames the cone's centre 23% across a 2:1 image, i.e. NDC -0.54.
	wide: { aspect: 1.9, anchorX: - 0.54, width: 1, height: 1 },
	narrow: { aspect: 0.5, anchorX: - 0.34, width: 0.46, height: 0.94 }
};

/**
 * The generated cone. Used only if assets/models/mountain_custom.glb goes missing, and as the
 * height an imported mountain is fitted to. No sliders: there is one mountain, from the artist.
 *
 * exposure and unlit are the look it needs in place of the artist's: its map is painted
 * near-black for the grade to lift, and it is lit by the sky rather than baked.
 */
export const MOUNTAIN_BLOCKOUT = {
	// a stratovolcano, not a party hat: `profile` above 1 steepens the flanks toward the
	// summit and flares the base
	radius: 5.2,
	height: 4.3,
	profile: 1.2,
	ridgeAmount: 0.16,

	// the unbroken cap, and the snow tongues that run down the gullies below it
	snowLine: 0.72,
	tongueLength: 0.42,
	tongueCount: 15,
	rockWarmth: 1,

	lightWrap: 0.45,
	lightTint: 0.2,
	exposure: 1.6,
	unlit: 0
};

/**
 * The red cabin, and the door that leaves the home page.
 *
 * Colours are measured off Reference/kazmos.jpg (wall [118,41,48] hue 354 sat 0.65; door
 * [44,50,57]; ornament [125,85,54] hue 26; eave [43,74,88]) and then pushed warmer and
 * brighter than the measurement, because the grade's cyan tint cools the whole frame on
 * the way out.
 *
 * Like the mountain it is framed by a screen anchor rather than a world x — the door is
 * the only clickable thing on the page, so it must survive a phone cropping the sides.
 * It sits much closer than the mountain, so it takes the scene's real SDF fog.
 */
export const CABIN = {
	// Kept in *front* of the hill's crest, which sits around z = -1.5. Sizing the cabin from
	// the reference's door-to-frame ratio alone put it at 7 units, where the meadow simply
	// buries it — occlusion does not care how well the proportions match. So it stands close
	// and is built small to suit: on screen that is indistinguishable from a large cabin
	// further off, and it is the only version the camera can actually see.
	distance: 3,
	yaw: - 0.32,
	sink: 0.02,

	// Tuned for the artist's model, assets/models/cabin_custom.glb, which loads at startup:
	// baked lighting, so unlit at a lower exposure (0.5 puts the wall at [119,68,70] against
	// the reference [118,41,48]); fitted to the blockout's height; nudged left until its door
	// frame sits where the reference has it, 81.7% across.
	modelScale: 0.83,
	screenX: - 0.21,
	exposure: 0.5,
	unlit: 1,

	// The reference puts the cabin's near corner about 75% across a 2:1 frame, i.e. NDC
	// +0.49, and lets the rest run off the edge.
	wide: { aspect: 1.9, anchorX: 1.05, scale: 1 },
	narrow: { aspect: 0.5, anchorX: 0.78, scale: 0.82 }
};

/**
 * The generated cabin. Used only if assets/models/cabin_custom.glb goes missing, and as the
 * height an imported cabin is fitted to. No sliders: there is one cabin, from the artist.
 *
 * Its door plane is kept on the artist's model too, invisible, as the click target.
 */
export const CABIN_BLOCKOUT = {
	width: 1.1,
	height: 1.35,
	depth: 1,
	eaveOverhang: 0.07,
	eaveHeight: 0.075,

	// The door is not centred on the wall: the reference puts it about 12% of the frame in
	// from the cabin's near corner, with the rest of the building running off the edge.
	doorWidth: 0.33,
	doorHeight: 0.78,
	doorOffsetX: - 0.26,

	// Radius of the sun's petal ring as a fraction of the door's width; the tips reach 1.42x.
	ornamentSize: 0.14,
	ornamentRays: 8,
	ornamentSwirl: 0.55,
	lampSize: 0.2,

	weathering: 0.35,
	grain: 0.22,
	lightWrap: 0.35,
	lightTint: 0.3,
	// how much darker the side wall reads than the face-on one — this is the corner
	faceTint: 0.32,
	eaveColor: [ 0.130, 0.235, 0.300 ],

	exposure: 1.6,
	unlit: 0
};

/**
 * Framing on viewports that are not the hero shot's shape.
 *
 * fov in three is vertical, so a narrow viewport does not zoom out — it crops the sides.
 * At 30 degrees vertical a portrait phone (aspect 0.46) sees only 14 degrees horizontally,
 * which is not enough room for the mountain, the title and the cabin door at once.
 * Widening the vertical fov buys that room back; the cost is more grass and sky above and
 * below than the hero framing was tuned for, so it is held to the minimum that works.
 */
export const RESPONSIVE = {
	minHorizontalFov: 22,
	maxFov: 46
};

/**
 * Insects, placed by hand. `y` is height *above the ground*, so these survive a change
 * of hill. `strength` scales the wander amplitude.
 */
// Kept clear of the lens: at a camera distance of ~3 a 0.3-unit sprite one unit away
// fills a third of the frame, so these sit mid-ground and beyond.
export const INSECTS = [
	{ type: 'dragonfly', position: [ 0.35, 0.34, 0.55 ], yaw: 0.5, scale: 0.26, strength: 1 },
	{ type: 'bee', position: [ - 0.85, 0.26, - 0.35 ], yaw: - 0.6, scale: 0.17, strength: 1.2 },
	{ type: 'bee', position: [ 1.45, 0.30, 1.25 ], yaw: 1.1, scale: 0.15, strength: 0.9 },
	{ type: 'fly', position: [ - 1.55, 0.22, - 1.15 ], yaw: - 1.4, scale: 0.13, strength: 1.4 },
	{ type: 'dragonfly', position: [ 2.15, 0.40, - 1.35 ], yaw: 2.3, scale: 0.22, strength: 0.8 }
];
