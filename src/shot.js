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
