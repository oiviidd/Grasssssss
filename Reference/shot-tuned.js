// Tuned in the browser — paste over the matching blocks in src/shot.js.
// Eye sits 0.21 above the local ground (ground y = 0).
// fov 30

	camera: {
		position: [ 0.795, 0.208, 6.103 ],
		rotation: [ 0.005, -0.005, 0 ],
		cameraDistance: 3
	},

// grade — vignetteFrom/To and tintOpacity inside SHOT.grade
//   vignetteFrom: 0.477,
//   vignetteTo: 1.171,
//   tintOpacity: 0.203,

export const FOG = {
	boxSize: 6,
	radius: 1,
	start: 1.95,
	range: 0.7,
	centre: [ -0.1, -1 ],
	hazeStart: 5.9,
	hazeRange: 6.5,
	hazeAmount: 0.32
};

export const MOUNTAIN = {
	distance: 11.8,
	summitY: 2.8,
	modelScale: 0.58,
	screenX: -0.03,
	exposure: 0.75,
	unlit: 1,
	haze: 0,
	baseMist: 0.16,
	baseMistHeight: 0.46,
	wide: { aspect: 1.9, anchorX: -0.54, width: 1, height: 1 },
	narrow: { aspect: 0.5, anchorX: -0.34, width: 0.46, height: 0.94 }
};

export const CABIN = {
	distance: 6.484,
	yaw: -1.02,
	sink: 0.15,
	modelScale: 1.62,
	screenX: -0.17,
	exposure: 0.75,
	unlit: 1,
	wide: { aspect: 1.9, anchorX: 1.05, scale: 1 },
	narrow: { aspect: 0.5, anchorX: 0.78, scale: 0.82 }
};

export const RESPONSIVE = {
	minHorizontalFov: 22,
	maxFov: 46
};

export const GRASS = {
	grassExtent: 4.99,
	rimFade: 0.2,
	maxSlope: 0.62,
	bladeCount: 160000,
	bladeWidthScale: 0.42,
	bladeHeightScale: 0.8,
	tuftInstances: 2310,
	tuftScale: 1,
	flowerCount: 1100,
	flowerScale: 0.5
};
