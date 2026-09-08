/**
 * A study reconstruction of the grass + lighting of Lusion's "My Little Storybook"
 * (https://exp-my-little-storybook.lusion.co/), rebuilt on our own hill.
 *
 * Every shader that draws a pixel here is the original site's GLSL, extracted from its
 * shipped bundle. The blade mesh, the sculpted tuft mesh, the flower atlas, the insect
 * sprite sheets, the sky env map and the rock texture are its assets. What is ours: the
 * hill, the scatter, the camera framing, and all the plumbing.
 *
 * Left out on purpose: the river and its water plants, the birds and the storybook
 * scripting, audio, UI, and the bokeh depth-of-field pass.
 *
 * How the look actually works, in one paragraph. There are no lights in this scene. The
 * ground and every blade take their albedo from one shared projected colour map, get a
 * ±5% wrap term along a hard-coded sun direction vec3(0.5733), and then dissolve into an
 * equirectangular sky texture through an SDF-shaped fog — so the "lighting" is entirely
 * an environment lookup. The beauty pass that comes out is consequently almost black. A
 * bloom whose strength is inversely weighted by local luminance, followed by a
 * colour-dodge tint, is what lifts it into daylight. All the motion is a single 4D
 * simplex-noise-gradient lookup per vertex.
 */
import * as THREE from '../vendor/three.module.js';
import * as FboHelper from './FboHelper.js';
import { fogChunk } from './glsl/fog.js';
import { terrainVert, terrainFrag, terrainDrawFrag } from './glsl/terrain.js';
import { skyVert, skyFrag } from './glsl/sky.js';
import { quadVert } from './glsl/post.js';
import { Bloom, FinalGrade } from './Postprocessing.js';
import { CameraRig } from './CameraRig.js';
import { createHillGeometry, HILL_DEFAULTS } from './HillGeometry.js';
import { TerrainSurface } from './TerrainSurface.js';
import { bakeTerrainMaps } from './TerrainMaps.js';
import { Grass } from './Grass.js';
import { Flowers } from './Flowers.js';
import { Insects } from './Insects.js';
import { exportGLB, exportOBJ, loadCustomTerrain } from './TerrainIO.js';
import { Mountain, createMountainGeometry, bakeMountainMap } from './Mountain.js';
import { Cabin } from './Cabin.js';
import { SHOT, INSECTS, GRASS, FOG, MOUNTAIN, CABIN, RESPONSIVE } from './shot.js';
import { TweakPanel } from './TweakPanel.js';
import { pickFile, parseGLB, normaliseProp, ensureYRatio, loadImageTexture, exportGeometryGLB, exportTexturePNG } from './AssetIO.js';

// The fog/sky chunk is shared by ShaderMaterial and RawShaderMaterial alike — three
// resolves #include for both.
THREE.ShaderChunk.lusionFog = fogChunk;

const MODEL_PATH = 'assets/models/';
const TEXTURE_PATH = 'assets/textures/';
const CUSTOM_TERRAIN = MODEL_PATH + 'terrain_custom.glb';

const STAGE_SIZE = 10;
const MAP_RESOLUTION = 512;

/**
 * The stage: the world-space square the baked terrain maps (colour, rock, AO) and the
 * interaction field cover.
 *
 * It used to be a fixed 10 units centred on the origin, matching a hard-coded
 * `xz / 10.0 + 0.5` in four shaders. A hill sculpted in Blender is rarely centred there —
 * zamin18.glb runs z -6.99 .. +2.99 — and everything outside the box fell out of both the
 * baked maps and the scatter, which showed up as the far hill staying bald. The box now
 * follows the mesh, so a sculpt is covered wherever the artist leaves it.
 *
 * Kept square: the AO bake marches in texels, and anisotropic ones would read a stretched
 * horizon.
 */
const stage = {
	centre: new THREE.Vector2( 0, 0 ),
	size: STAGE_SIZE
};
/**
 * How far from the origin the scatter reaches, and how steep a face still grows grass.
 *
 * 4.7 is tuned for the procedural hill, whose rim deliberately droops and dissolves into
 * the fog — grass thinning out over the last unit is the point. A sculpted hill usually
 * fills the whole stage instead, and then the same taper strips grass off everything past
 * |x| or |z| = 3.6 and all of it past 4.7, which reads as a bare hill in the background.
 * Re-derived from the mesh's own bounds when a custom terrain is loaded.
 */
let rimRadius = 4.7;
let rimFade = 1.1;
let scatterBounds = null;
let maxSlope = 0.62;

/** Fits the stage box to the loaded mesh. Must run before anything bakes or scatters. */
function deriveStage() {

	const box = surface.boundingBox;

	stage.centre.set( ( box.min.x + box.max.x ) * 0.5, ( box.min.z + box.max.z ) * 0.5 );
	stage.size = Math.max( 1e-3, box.max.x - box.min.x, box.max.z - box.min.z );
	uniforms.u_stageSize.value = stage.size;

	return stage;

}

const container = document.getElementById( 'app' );
const loaderEl = document.getElementById( 'loader' );
const loaderBarEl = document.getElementById( 'loader-bar' );
const statusEl = document.getElementById( 'status' );

/* ── renderer ──────────────────────────────────────────────────────────────── */

const renderer = new THREE.WebGLRenderer( { antialias: false, alpha: false } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.autoClear = false;
// The original renders with no gamma conversion at all; the grade pass is what brings
// the image up. r122 defaults to LinearEncoding, which matches — set explicitly so the
// intent survives a three upgrade.
renderer.outputEncoding = THREE.LinearEncoding;
container.appendChild( renderer.domElement );

const isWebGL2 = renderer.capabilities.isWebGL2;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 30, 1, 0.05, 20 );
const cameraRig = new CameraRig( camera, renderer.domElement );

/* ── shared uniforms ───────────────────────────────────────────────────────── */

const uniforms = {
	u_time: { value: 0 },
	u_envTexture: { value: null },

	// Fog shape. Every material that includes <lusionFog> needs these, so they live on the
	// shared object and are merged in wherever a material is built.
	u_fogBox: { value: new THREE.Vector2( FOG.boxSize, FOG.boxSize ) },
	u_fogCentre: { value: new THREE.Vector2( FOG.centre[ 0 ], FOG.centre[ 1 ] ) },
	u_fogRadius: { value: FOG.radius },
	u_fogStart: { value: FOG.start },
	u_fogRange: { value: FOG.range },
	u_hazeStart: { value: FOG.hazeStart },
	u_hazeRange: { value: FOG.hazeRange },
	u_hazeAmount: { value: FOG.hazeAmount },

	u_terrainInfoTexture: { value: null },
	u_terrainGrassTexture: { value: null },
	u_terrainRocksTexture: { value: null },
	u_terrainAOTexture: { value: null },
	u_terrainDrawTexture: { value: null },

	// Shared by everything that reads a baked terrain map. `value` aliases stage.centre,
	// so moving the stage updates every material at once; the size has to be pushed.
	u_stageCentre: { value: stage.centre },
	u_stageSize: { value: stage.size }
};

/* ── render targets ────────────────────────────────────────────────────────── */

function createSceneTarget() {

	const options = {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
		type: THREE.UnsignedByteType,
		stencilBuffer: false
	};

	// The original ran SMAA as a post pass; hardware MSAA on the scene target is the
	// simpler equivalent wherever WebGL2 exists. Grass is nothing but thin silhouettes,
	// so this matters more here than it would in most scenes.
	return isWebGL2
		? new THREE.WebGLMultisampleRenderTarget( 1, 1, options )
		: new THREE.WebGLRenderTarget( 1, 1, options );

}

const sceneTarget = createSceneTarget();
const bloomTarget = FboHelper.createRenderTarget();

const bloom = new Bloom();
const grade = new FinalGrade();

/* ── the interaction field ─────────────────────────────────────────────────── */

const drawTargets = [ FboHelper.createRenderTarget( 256, 256 ), FboHelper.createRenderTarget( 256, 256 ) ];
let drawRead = 0;

const drawMaterial = new THREE.RawShaderMaterial( {
	uniforms: {
		u_texture: { value: null },
		u_mouseXZ: { value: new THREE.Vector2() },
		u_mouseRadius: { value: 0.5 },
		u_mouseStrength: { value: 0 },
		u_drag: { value: 0.975 },
		u_stageCentre: uniforms.u_stageCentre,
		u_stageSize: uniforms.u_stageSize
	},
	vertexShader: FboHelper.PRECISION_PREFIX + quadVert,
	fragmentShader: FboHelper.PRECISION_PREFIX + terrainDrawFrag,
	blending: THREE.NoBlending,
	depthTest: false,
	depthWrite: false
} );

const raycaster = new THREE.Raycaster();
const mousePixel = new THREE.Vector2();
const prevMousePixel = new THREE.Vector2();
const hitPoint = new THREE.Vector3();

let terrainMesh = null;
let skyMesh = null;
let surface = null;
let insects = null;
let usingCustomTerrain = false;

/* ── asset loading ─────────────────────────────────────────────────────────── */

const textureLoader = new THREE.TextureLoader();

function loadTexture( file, options ) {

	const { flipY = true, wrap = null, minFilter = null } = options || {};

	return new Promise( ( resolve, reject ) => {

		const texture = textureLoader.load( TEXTURE_PATH + file, () => resolve( texture ), undefined, reject );

		texture.flipY = flipY;
		if ( wrap ) texture.wrapS = texture.wrapT = wrap;

		if ( minFilter ) {

			texture.minFilter = minFilter;
			texture.generateMipmaps = false;

		} else {

			texture.minFilter = THREE.LinearMipMapLinearFilter;
			texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

		}

	} );

}

const grass = new Grass( uniforms );
const flowers = new Flowers( uniforms );
const mountain = new Mountain( uniforms );
const cabin = new Cabin( uniforms );

const jobs = [
	[ 'sky', () => loadTexture( 'sky.jpg', { flipY: false, wrap: THREE.MirroredRepeatWrapping } ) ],
	[ 'noise', () => loadTexture( 'noise.png', { wrap: THREE.RepeatWrapping, minFilter: THREE.LinearFilter } ) ],
	[ 'rocksGround', () => loadTexture( 'rocks_ground_01.jpg', { wrap: THREE.RepeatWrapping } ) ],
	[ 'flowers', () => loadTexture( 'flowers.png' ) ],
	[ 'grass', () => grass.load( MODEL_PATH ) ],
	[ 'insects', () => {

		insects = new Insects( uniforms );
		return insects.load( TEXTURE_PATH );

	} ],
	// resolves null when no sculpted hill has been dropped in yet
	[ 'customTerrain', () => loadCustomTerrain( CUSTOM_TERRAIN ).catch( () => null ) ]
];

let completed = 0;

Promise.all( jobs.map( ( [ key, run ] ) => run().then( value => {

	completed ++;
	loaderBarEl.style.transform = 'scaleX(' + ( completed / jobs.length ) + ')';
	return [ key, value ];

} ) ) )
	.then( entries => {

		const assets = {};
		entries.forEach( ( [ key, value ] ) => { assets[ key ] = value; } );
		build( assets );

	} )
	.catch( error => {

		console.error( error );
		loaderEl.innerHTML = '<p class="loader-error">Assets failed to load.<br>Serve this folder over HTTP — see README.md.</p>';

	} );

/* ── scene construction ────────────────────────────────────────────────────── */

function build( assets ) {

	uniforms.u_envTexture.value = assets.sky;
	uniforms.u_terrainRocksTexture.value = assets.rocksGround;

	/* the hill ---------------------------------------------------------------- */

	usingCustomTerrain = !! assets.customTerrain;
	const hillGeometry = usingCustomTerrain ? assets.customTerrain : createHillGeometry();

	surface = new TerrainSurface( hillGeometry );

	// Order matters: the raster below, the scatter, and every terrain-map lookup are all
	// expressed in stage space.
	deriveStage();
	if ( usingCustomTerrain ) deriveScatterExtent();

	// Bake the maps the original shipped as painted textures. They have to be generated
	// rather than reused: grass.jpg has the river channel stained into it, and the AO /
	// rock masks follow the old riverbed.
	const raster = surface.rasterize( MAP_RESOLUTION, stage.size, stage.centre.x, stage.centre.y );
	const maps = bakeTerrainMaps( raster );

	uniforms.u_terrainGrassTexture.value = maps.grassTexture;
	uniforms.u_terrainInfoTexture.value = maps.infoTexture;
	uniforms.u_terrainAOTexture.value = maps.aoTexture;

	// "No push anywhere": rg = 0.5 is a zero direction, b = 0 is no disturbance.
	FboHelper.clearTarget( renderer, drawTargets[ 0 ], 0.5, 0.5, 0, 1 );
	FboHelper.clearTarget( renderer, drawTargets[ 1 ], 0.5, 0.5, 0, 1 );
	uniforms.u_terrainDrawTexture.value = drawTargets[ 0 ].texture;

	/* sky --------------------------------------------------------------------- */

	skyMesh = new THREE.Mesh(
		new THREE.SphereBufferGeometry( 15, 32, 24 ),
		new THREE.ShaderMaterial( {
			uniforms: {
				u_time: uniforms.u_time,
				u_noiseTexture: { value: assets.noise },
				u_envTexture: uniforms.u_envTexture,
				u_fogBox: uniforms.u_fogBox,
				u_fogCentre: uniforms.u_fogCentre,
				u_fogRadius: uniforms.u_fogRadius,
				u_fogStart: uniforms.u_fogStart,
				u_fogRange: uniforms.u_fogRange,
				u_hazeStart: uniforms.u_hazeStart,
				u_hazeRange: uniforms.u_hazeRange,
				u_hazeAmount: uniforms.u_hazeAmount
			},
			vertexShader: skyVert,
			fragmentShader: skyFrag,
			side: THREE.BackSide
		} )
	);
	skyMesh.frustumCulled = false;
	scene.add( skyMesh );

	/* the mountain ------------------------------------------------------------ */

	buildMountain();
	scene.add( mountain.container );

	/* ground ------------------------------------------------------------------ */

	terrainMesh = new THREE.Mesh( hillGeometry, new THREE.ShaderMaterial( {
		uniforms: {
			u_envTexture: uniforms.u_envTexture,
			u_fogBox: uniforms.u_fogBox,
			u_fogCentre: uniforms.u_fogCentre,
			u_fogRadius: uniforms.u_fogRadius,
			u_fogStart: uniforms.u_fogStart,
			u_fogRange: uniforms.u_fogRange,
			u_hazeStart: uniforms.u_hazeStart,
			u_hazeRange: uniforms.u_hazeRange,
			u_hazeAmount: uniforms.u_hazeAmount,
			u_terrainInfoTexture: uniforms.u_terrainInfoTexture,
			u_terrainGrassTexture: uniforms.u_terrainGrassTexture,
			u_terrainRocksTexture: uniforms.u_terrainRocksTexture,
			u_terrainAOTexture: uniforms.u_terrainAOTexture,
			u_stageCentre: uniforms.u_stageCentre,
			u_stageSize: uniforms.u_stageSize
		},
		vertexShader: terrainVert,
		fragmentShader: terrainFrag
	} ) );
	terrainMesh.material.extensions.derivatives = true;
	terrainMesh.renderOrder = - 1000;
	scene.add( terrainMesh );

	/* grass, flowers, insects ------------------------------------------------- */

	grass.build( surface, {
		rimRadius,
		rimFade,
		maxSlope,
		bounds: scatterArea(),
		bladeCount: GRASS.bladeCount,
		bladeWidthScale: GRASS.bladeWidthScale,
		bladeHeightScale: GRASS.bladeHeightScale,
		tuftInstances: GRASS.tuftInstances,
		tuftScale: GRASS.tuftScale
	} );
	scene.add( grass.container );

	flowers.build( surface, assets.flowers, {
		rimRadius,
		rimFade,
		maxSlope,
		bounds: scatterArea(),
		flowerCount: GRASS.flowerCount,
		flowerScale: GRASS.flowerScale
	} );
	scene.add( flowers.container );

	insects.build( surface, INSECTS );
	scene.add( insects.container );

	/* the cabin --------------------------------------------------------------- */

	buildCabin();
	scene.add( cabin.container );

	/* go ---------------------------------------------------------------------- */

	applyShot();
	onResize();
	window.addEventListener( 'resize', onResize );
	bindInput();
	buildTweakPanel( assets.flowers );

	updateStatus();

	loaderEl.classList.add( 'is-hidden' );
	document.getElementById( 'hud' ).classList.add( 'is-visible' );

	// Handle for poking at the scene from the console.
	window.grassStudy = {
		renderer, scene, camera, cameraRig, bloom, grade, uniforms,

		// Live getters, not snapshots. installTerrain() reassigns these module bindings, so
		// a plain property would keep handing back the terrain that was loaded at startup —
		// which silently invalidates anything measured through the handle afterwards.
		get surface() { return surface; },
		get scatterBounds() { return scatterBounds; },
		get grass() { return grass; },
		get flowers() { return flowers; },
		get insects() { return insects; },

		hill: HILL_DEFAULTS,
		installTerrain,
		tuned,
		exportGLB: () => exportGLB( terrainMesh ),
		exportOBJ: () => exportOBJ( terrainMesh ),

		/** Drive one frame by hand. requestAnimationFrame is paused in a hidden tab, so
		 *  this is the only way to exercise the pipeline from a headless check. */
		step: ( dt = 1 / 60 ) => frame( dt ),

		/**
		 * Rebuild the grass with different tuning without reloading, so blade scale and
		 * density can be swept against the reference metrics in one session.
		 * Pass the values you want to change; the rest fall back to GRASS in shot.js.
		 */
		rebuildGrass( overrides = {} ) {

			const options = Object.assign( {}, GRASS, overrides );

			grass.dispose();
			grass.build( surface, {
				rimRadius,
				rimFade,
				maxSlope,
				bounds: scatterArea(),
				bladeCount: options.bladeCount,
				bladeWidthScale: options.bladeWidthScale,
				bladeHeightScale: options.bladeHeightScale,
				tuftInstances: options.tuftInstances,
				tuftScale: options.tuftScale
			} );

			return { blades: grass.bladeCount, tufts: grass.tuftCount, options };

		},

		/**
		 * Measure the render with the same maths tools/measure_reference.py applies to the
		 * reference photo, then print them side by side. Loads tools/reference-metrics.json
		 * for the target, so it always compares against whatever image was last measured.
		 */
		async measure() {

			const [ { measureRender, compare }, reference ] = await Promise.all( [
				import( './measure.js' ),
				fetch( 'tools/reference-metrics.json' ).then( r => r.json() )
			] );

			const [ width, height ] = reference.size;
			const mine = measureRender(
				{ renderer, scene, camera, bloom, grade },
				width, height, reference.excludeX || []
			);

			console.table( compare( mine, reference ) );
			return { mine, reference };

		},

		/** Read the ungraded beauty pass at a viewport pixel. Returns [r,g,b,a] 0-255. */
		sampleBeauty( x, y ) {

			const buffer = new Uint8Array( 4 );
			const pixelRatio = renderer.getPixelRatio();
			renderer.readRenderTargetPixels(
				sceneTarget,
				Math.round( x * pixelRatio ),
				height - Math.round( y * pixelRatio ),
				1, 1, buffer
			);
			return Array.from( buffer );

		},

		/** Sample the interaction field at a world xz position. Returns [r,g,b,a] 0-255. */
		sampleField( x, z ) {

			const buffer = new Uint8Array( 4 );
			renderer.readRenderTargetPixels(
				drawTargets[ drawRead ],
				Math.round( ( ( x - stage.centre.x ) / stage.size + 0.5 ) * 256 ),
				Math.round( ( ( z - stage.centre.y ) / stage.size + 0.5 ) * 256 ),
				1, 1, buffer
			);
			return Array.from( buffer );

		}
	};

	lastTime = performance.now() / 1000;
	requestAnimationFrame( animate );

}

/* ── shot ──────────────────────────────────────────────────────────────────── */

/* ── tweak panel ───────────────────────────────────────────────────────────── */

let panel = null;
let flowerTexture = null;

/** Live tuning values, seeded from shot.js and edited by the panel. */
const tuned = {
	posX: SHOT.camera.position[ 0 ],
	posY: SHOT.camera.position[ 1 ],
	posZ: SHOT.camera.position[ 2 ],
	pitch: SHOT.camera.rotation[ 0 ],
	yaw: SHOT.camera.rotation[ 1 ],
	fov: camera.fov,

	bladeCount: GRASS.bladeCount,
	bladeWidthScale: GRASS.bladeWidthScale,
	bladeHeightScale: GRASS.bladeHeightScale,
	tuftInstances: GRASS.tuftInstances,
	tuftScale: GRASS.tuftScale,
	flowerCount: GRASS.flowerCount,
	flowerScale: GRASS.flowerScale,
	atlasCells: 5,

	fogBox: FOG.boxSize,
	fogStart: FOG.start,
	fogRange: FOG.range,
	mountainDistance: MOUNTAIN.distance,
	mountainSummitY: MOUNTAIN.summitY,
	mountainRadius: MOUNTAIN.radius,
	mountainHeight: MOUNTAIN.height,
	mountainProfile: MOUNTAIN.profile,
	mountainRidge: MOUNTAIN.ridgeAmount,
	mountainSnowLine: MOUNTAIN.snowLine,
	mountainRockWarmth: MOUNTAIN.rockWarmth,
	mountainTongueLength: MOUNTAIN.tongueLength,
	mountainTongueCount: MOUNTAIN.tongueCount,
	mountainBaseMist: MOUNTAIN.baseMist,
	mountainBaseMistHeight: MOUNTAIN.baseMistHeight,
	mountainLightWrap: MOUNTAIN.lightWrap,
	mountainSnowBrightness: 1,
	mountainSnowShade: 1,
	mountainRockContrast: 1,

	cabinDistance: CABIN.distance,
	cabinYaw: CABIN.yaw,
	cabinSink: CABIN.sink,
	cabinWidth: CABIN.width,
	cabinHeight: CABIN.height,
	cabinDepth: CABIN.depth,
	cabinDoorWidth: CABIN.doorWidth,
	cabinDoorHeight: CABIN.doorHeight,
	cabinDoorOffsetX: CABIN.doorOffsetX,
	cabinOrnamentSize: CABIN.ornamentSize,
	cabinOrnamentRays: CABIN.ornamentRays,
	cabinOrnamentSwirl: CABIN.ornamentSwirl,
	cabinLampSize: CABIN.lampSize,
	cabinWeathering: CABIN.weathering,
	cabinGrain: CABIN.grain,
	cabinExposure: CABIN.exposure,
	cabinLightWrap: CABIN.lightWrap,
	cabinLightTint: CABIN.lightTint,
	cabinFaceTint: CABIN.faceTint,
	mountainExposure: MOUNTAIN.exposure,
	mountainHaze: MOUNTAIN.haze,
	mountainLightTint: MOUNTAIN.lightTint,

	minHFov: RESPONSIVE.minHorizontalFov,
	maxFov: RESPONSIVE.maxFov,

	fogCentreX: FOG.centre[ 0 ],
	fogCentreZ: FOG.centre[ 1 ],
	hazeStart: FOG.hazeStart,
	hazeRange: FOG.hazeRange,
	hazeAmount: FOG.hazeAmount,

	grassExtent: rimRadius,
	rimFade: rimFade,
	maxSlope: maxSlope,

	vignetteFrom: SHOT.grade.vignetteFrom,
	vignetteTo: SHOT.grade.vignetteTo,
	tintOpacity: SHOT.grade.tintOpacity
};

let rebuildTimer = null;

/**
 * A scatter rebuild at 160k blades takes long enough to stutter, so slider drags are
 * coalesced rather than fired per pixel of movement.
 */
function scheduleRebuild( what ) {

	clearTimeout( rebuildTimer );
	if ( panel ) panel.say( 'rebuilding…' );

	rebuildTimer = setTimeout( () => {

		if ( what === 'flowers' ) {

			flowers.dispose();
			flowers.build( surface, flowerTexture, {
				rimRadius,
				rimFade,
				maxSlope,
				bounds: scatterArea(),
				flowerCount: tuned.flowerCount,
				flowerScale: tuned.flowerScale,
				atlasCells: tuned.atlasCells
			} );

		} else {

			grass.dispose();
			grass.build( surface, {
				rimRadius,
				rimFade,
				maxSlope,
				bounds: scatterArea(),
				bladeCount: tuned.bladeCount,
				bladeWidthScale: tuned.bladeWidthScale,
				bladeHeightScale: tuned.bladeHeightScale,
				tuftInstances: tuned.tuftInstances,
				tuftScale: tuned.tuftScale
			} );

		}

		updateStatus();

		if ( panel ) {

			const clamped = grass.tuftClamped;
			panel.say( clamped
				? `Tuft count capped at ${clamped.instances} (asked ${clamped.requested}) — that mesh is heavy.`
				: '' );

		}

	}, 260 );

}

function applyTunedCamera() {

	cameraRig.setAnchor( {
		position: [ tuned.posX, tuned.posY, tuned.posZ ],
		rotation: [ tuned.pitch, tuned.yaw, 0 ],
		cameraDistance: SHOT.camera.cameraDistance
	} );

	const fov = fovForAspect( camera.aspect );

	if ( camera.fov !== fov ) {

		camera.fov = fov;
		camera.updateProjectionMatrix();

	}

	placeMountain();
	placeCabin();

}

function configText() {

	const f = ( v, d = 3 ) => Number( v.toFixed( d ) );
	const sample = { y: 0, nx: 0, ny: 1, nz: 0 };
	const ground = surface.sample( tuned.posX, tuned.posZ, sample ) ? sample.y : 0;

	return `// Tuned in the browser — paste over the matching blocks in src/shot.js.
// Eye sits ${f( tuned.posY - ground, 2 )} above the local ground (ground y = ${f( ground, 3 )}).
// fov ${f( tuned.fov, 1 )}

	camera: {
		position: [ ${f( tuned.posX )}, ${f( tuned.posY )}, ${f( tuned.posZ )} ],
		rotation: [ ${f( tuned.pitch, 4 )}, ${f( tuned.yaw, 4 )}, 0 ],
		cameraDistance: ${SHOT.camera.cameraDistance}
	},

// grade — vignetteFrom/To and tintOpacity inside SHOT.grade
//   vignetteFrom: ${f( tuned.vignetteFrom, 3 )},
//   vignetteTo: ${f( tuned.vignetteTo, 3 )},
//   tintOpacity: ${f( tuned.tintOpacity, 3 )},

export const FOG = {
	boxSize: ${f( tuned.fogBox, 2 )},
	radius: ${FOG.radius},
	start: ${f( tuned.fogStart, 2 )},
	range: ${f( tuned.fogRange, 2 )},
	centre: [ ${f( tuned.fogCentreX, 2 )}, ${f( tuned.fogCentreZ, 2 )} ],
	hazeStart: ${f( tuned.hazeStart, 2 )},
	hazeRange: ${f( tuned.hazeRange, 2 )},
	hazeAmount: ${f( tuned.hazeAmount, 3 )}
};

export const MOUNTAIN = {
	distance: ${f( tuned.mountainDistance, 2 )},
	summitY: ${f( tuned.mountainSummitY, 2 )},
	radius: ${f( tuned.mountainRadius, 2 )},
	height: ${f( tuned.mountainHeight, 2 )},
	profile: ${f( tuned.mountainProfile, 2 )},
	ridgeAmount: ${f( tuned.mountainRidge, 3 )},
	snowLine: ${f( tuned.mountainSnowLine, 3 )},
	rockWarmth: ${f( tuned.mountainRockWarmth, 2 )},
	tongueLength: ${f( tuned.mountainTongueLength, 2 )},
	tongueCount: ${Math.round( tuned.mountainTongueCount )},
	baseMist: ${f( tuned.mountainBaseMist, 2 )},
	baseMistHeight: ${f( tuned.mountainBaseMistHeight, 2 )},
	exposure: ${f( tuned.mountainExposure, 2 )},
	haze: ${f( tuned.mountainHaze, 3 )},
	lightWrap: ${MOUNTAIN.lightWrap},
	lightTint: ${f( tuned.mountainLightTint, 2 )},
	wide: { aspect: ${MOUNTAIN.wide.aspect}, anchorX: ${MOUNTAIN.wide.anchorX}, width: ${MOUNTAIN.wide.width}, height: ${MOUNTAIN.wide.height} },
	narrow: { aspect: ${MOUNTAIN.narrow.aspect}, anchorX: ${MOUNTAIN.narrow.anchorX}, width: ${MOUNTAIN.narrow.width}, height: ${MOUNTAIN.narrow.height} }
};

export const RESPONSIVE = {
	minHorizontalFov: ${f( tuned.minHFov, 1 )},
	maxFov: ${f( tuned.maxFov, 1 )}
};

export const GRASS = {
	grassExtent: ${f( tuned.grassExtent, 2 )},
	rimFade: ${f( tuned.rimFade, 2 )},
	maxSlope: ${f( tuned.maxSlope, 2 )},
	bladeCount: ${Math.round( tuned.bladeCount )},
	bladeWidthScale: ${f( tuned.bladeWidthScale, 2 )},
	bladeHeightScale: ${f( tuned.bladeHeightScale, 2 )},
	tuftInstances: ${Math.round( tuned.tuftInstances )},
	tuftScale: ${f( tuned.tuftScale, 2 )},
	flowerCount: ${Math.round( tuned.flowerCount )},
	flowerScale: ${f( tuned.flowerScale, 2 )}
};
`;

}

function buildTweakPanel( texture ) {

	flowerTexture = texture;

	panel = new TweakPanel( {

		onCopy: configText,

		onChange( key, value ) {

			tuned[ key ] = value;

			if ( key === 'freeze' ) {

				// Shake and mouse-look fight the sliders — every adjustment lands on a
				// moving image. Off by default so the framing can be judged still.
				cameraRig.shakeStrength = value ? 0 : SHOT.grade.cameraShakeStrength;
				cameraRig.lookStrength = value ? 0 : SHOT.grade.cameraLookStrength;
				return;

			}

			if ( key === 'grassExtent' || key === 'rimFade' || key === 'maxSlope' ) {

				rimRadius = tuned.grassExtent;
				rimFade = tuned.rimFade;
				maxSlope = tuned.maxSlope;
				scheduleRebuild( 'grass' );
				setTimeout( () => scheduleRebuild( 'flowers' ), 320 );
				return;

			}

			if ( key.startsWith( 'vignette' ) || key === 'tintOpacity' ) {

				// Grade values are read on the frame, so these need no rebuild either.
				grade.vignetteFrom = tuned.vignetteFrom;
				grade.vignetteTo = tuned.vignetteTo;
				grade.tintOpacity = tuned.tintOpacity;
				return;

			}

			if ( key === 'minHFov' || key === 'maxFov' ) {

				applyTunedCamera();
				return;

			}

			if ( key === 'mountainDistance' || key === 'mountainSummitY' ) {

				placeMountain();
				return;

			}

			// Pure look — no geometry or map to regenerate, so push straight at the uniform.
			const liveMountain = {
				mountainExposure: 'u_exposure',
				mountainHaze: 'u_haze',
				mountainLightTint: 'u_lightTint',
				mountainBaseMist: 'u_baseMist',
				mountainBaseMistHeight: 'u_baseMistHeight',
				mountainLightWrap: 'u_lightWrap'
			};

			if ( liveMountain[ key ] ) {

				mountain.set( liveMountain[ key ], value );
				return;

			}

			if ( key === 'cabinDistance' || key === 'cabinYaw' || key === 'cabinSink' ) {

				placeCabin();
				return;

			}

			const liveCabin = {
				cabinExposure: 'u_exposure',
				cabinLightWrap: 'u_lightWrap',
				cabinLightTint: 'u_lightTint',
				cabinFaceTint: 'u_faceTint'
			};

			if ( liveCabin[ key ] ) {

				cabin.set( liveCabin[ key ], value );
				return;

			}

			if ( key.startsWith( 'cabin' ) ) {

				// size, door or paint — the geometry and the maps have to be regenerated
				buildCabin();
				return;

			}

			if ( key.startsWith( 'mountain' ) ) {

				// shape or snow line — the geometry and the map have to be regenerated
				buildMountain();
				return;

			}

			if ( key.startsWith( 'fog' ) || key.startsWith( 'haze' ) ) {

				applyTunedFog();
				return;

			}

			if ( key.startsWith( 'flower' ) ) scheduleRebuild( 'flowers' );
			else if ( key.startsWith( 'blade' ) || key.startsWith( 'tuft' ) ) scheduleRebuild( 'grass' );
			else applyTunedCamera();

		}

	} );

	panel
		.toggle( 'freeze', 'Freeze camera (no shake / mouse-look)', true )
		.group( 'Camera' )
		.slider( 'posX', 'position x', tuned.posX, - 4, 4, 0.01 )
		.slider( 'posY', 'position y', tuned.posY, - 1, 4, 0.01 )
		.slider( 'posZ', 'position z', tuned.posZ, - 4, 4.5, 0.01 )
		.slider( 'pitch', 'pitch', tuned.pitch, - 0.6, 0.6, 0.001 )
		.slider( 'yaw', 'yaw', tuned.yaw, - 1.2, 1.2, 0.001 )
		.slider( 'fov', 'fov', tuned.fov, 12, 70, 0.5 )
		.group( 'Grass' )
		.slider( 'bladeCount', 'blade count', tuned.bladeCount, 20000, 320000, 10000, 'rebuild' )
		.slider( 'bladeWidthScale', 'blade width', tuned.bladeWidthScale, 0.1, 1.6, 0.01, 'rebuild' )
		.slider( 'bladeHeightScale', 'blade height', tuned.bladeHeightScale, 0.2, 2, 0.01, 'rebuild' )
		.slider( 'tuftInstances', 'tuft count', tuned.tuftInstances, 0, 6000, 50, 'rebuild' )
		.slider( 'tuftScale', 'tuft height', tuned.tuftScale, 0.2, 2.5, 0.01, 'rebuild' )
		.slider( 'grassExtent', 'grass extent', tuned.grassExtent, 1, 4.9, 0.05, 'rebuild' )
		.slider( 'rimFade', 'edge fade', tuned.rimFade, 0.02, 2, 0.02, 'rebuild' )
		.slider( 'maxSlope', 'max slope', tuned.maxSlope, 0.15, 1, 0.01, 'rebuild' )
		.group( 'Fog' )
		.slider( 'fogBox', 'clear extent', tuned.fogBox, 1.5, 6, 0.05 )
		.slider( 'fogStart', 'fade start', tuned.fogStart, 0, 4, 0.05 )
		.slider( 'fogRange', 'fade softness', tuned.fogRange, 0.05, 3, 0.05 )
		.slider( 'fogCentreX', 'fog centre x', tuned.fogCentreX, - 5, 5, 0.1 )
		.slider( 'fogCentreZ', 'fog centre z', tuned.fogCentreZ, - 5, 5, 0.1 )
		.slider( 'hazeStart', 'haze start', tuned.hazeStart, 0, 14, 0.1 )
		.slider( 'hazeRange', 'haze range', tuned.hazeRange, 0.5, 20, 0.1 )
		.slider( 'hazeAmount', 'haze strength', tuned.hazeAmount, 0, 1, 0.01 )
		.group( 'Mountain' )
		.slider( 'mountainDistance', 'distance', tuned.mountainDistance, 6, 14, 0.1 )
		.slider( 'mountainSummitY', 'peak height', tuned.mountainSummitY, - 1, 6, 0.05 )
		.slider( 'mountainRadius', 'width', tuned.mountainRadius, 1, 9, 0.1 )
		.slider( 'mountainHeight', 'height', tuned.mountainHeight, 0.5, 8, 0.1 )
		.slider( 'mountainProfile', 'flank curve', tuned.mountainProfile, 1, 2.6, 0.05 )
		.slider( 'mountainRidge', 'ridges', tuned.mountainRidge, 0, 0.5, 0.01 )
		.slider( 'mountainSnowLine', 'snow line', tuned.mountainSnowLine, 0.1, 0.95, 0.01 )
		.slider( 'mountainRockWarmth', 'rock warmth', tuned.mountainRockWarmth, 0, 1, 0.01, 'rebuild' )
		.slider( 'mountainTongueLength', 'snow tongues', tuned.mountainTongueLength, 0, 0.8, 0.01, 'rebuild' )
		.slider( 'mountainTongueCount', 'tongue count', tuned.mountainTongueCount, 4, 30, 1, 'rebuild' )
		.slider( 'mountainBaseMist', 'base mist', tuned.mountainBaseMist, 0, 1, 0.01 )
		.slider( 'mountainBaseMistHeight', 'mist height', tuned.mountainBaseMistHeight, 0.05, 1, 0.01 )
		.slider( 'mountainExposure', 'brightness', tuned.mountainExposure, 0.1, 3, 0.05 )
		.slider( 'mountainHaze', 'haze', tuned.mountainHaze, 0, 1, 0.01 )
		.slider( 'mountainLightTint', 'sky tint', tuned.mountainLightTint, 0, 1, 0.01 )
		.slider( 'mountainLightWrap', 'light wrap', tuned.mountainLightWrap, 0, 1, 0.01 )
		.slider( 'mountainSnowBrightness', 'snow brightness', tuned.mountainSnowBrightness, 0.3, 1.4, 0.01, 'rebuild' )
		.slider( 'mountainSnowShade', 'snow shade', tuned.mountainSnowShade, 0.2, 1.6, 0.01, 'rebuild' )
		.slider( 'mountainRockContrast', 'rock contrast', tuned.mountainRockContrast, 0, 2, 0.01, 'rebuild' )
		.group( 'Cabin' )
		.slider( 'cabinDistance', 'distance', tuned.cabinDistance, 1, 6, 0.05 )
		.slider( 'cabinYaw', 'turn', tuned.cabinYaw, - 1.4, 1.4, 0.01 )
		.slider( 'cabinSink', 'ground offset', tuned.cabinSink, - 2.5, 1, 0.01 )
		.slider( 'cabinWidth', 'width', tuned.cabinWidth, 0.8, 6, 0.05, 'rebuild' )
		.slider( 'cabinHeight', 'height', tuned.cabinHeight, 1, 6, 0.05, 'rebuild' )
		.slider( 'cabinDepth', 'depth', tuned.cabinDepth, 0.5, 6, 0.05, 'rebuild' )
		.slider( 'cabinDoorWidth', 'door width', tuned.cabinDoorWidth, 0.3, 1.6, 0.01, 'rebuild' )
		.slider( 'cabinDoorHeight', 'door height', tuned.cabinDoorHeight, 0.8, 3, 0.01, 'rebuild' )
		.slider( 'cabinDoorOffsetX', 'door across wall', tuned.cabinDoorOffsetX, - 2.5, 2.5, 0.01, 'rebuild' )
		.slider( 'cabinOrnamentSize', 'sun size', tuned.cabinOrnamentSize, 0.05, 0.4, 0.01, 'rebuild' )
		.slider( 'cabinOrnamentRays', 'sun rays', tuned.cabinOrnamentRays, 4, 16, 1, 'rebuild' )
		.slider( 'cabinOrnamentSwirl', 'sun swirl', tuned.cabinOrnamentSwirl, 0, 1.4, 0.01, 'rebuild' )
		.slider( 'cabinLampSize', 'lamp size', tuned.cabinLampSize, 0, 1, 0.01, 'rebuild' )
		.slider( 'cabinWeathering', 'paint wear', tuned.cabinWeathering, 0, 1, 0.01, 'rebuild' )
		.slider( 'cabinGrain', 'door grain', tuned.cabinGrain, 0, 0.8, 0.01, 'rebuild' )
		.slider( 'cabinExposure', 'brightness', tuned.cabinExposure, 0.2, 4, 0.05 )
		.slider( 'cabinLightWrap', 'light wrap', tuned.cabinLightWrap, 0, 1, 0.01 )
		.slider( 'cabinLightTint', 'sky tint', tuned.cabinLightTint, 0, 1, 0.01 )
		.slider( 'cabinFaceTint', 'corner shading', tuned.cabinFaceTint, 0, 0.8, 0.01 )
		.group( 'Responsive' )
		.slider( 'minHFov', 'min horizontal fov', tuned.minHFov, 8, 40, 0.5 )
		.slider( 'maxFov', 'max vertical fov', tuned.maxFov, 30, 75, 0.5 )
		.group( 'Grade' )
		.slider( 'vignetteFrom', 'vignette start', tuned.vignetteFrom, 0, 1.5, 0.01 )
		.slider( 'vignetteTo', 'vignette end', tuned.vignetteTo, 0.2, 2.5, 0.01 )
		.slider( 'tintOpacity', 'tint strength', tuned.tintOpacity, 0, 0.6, 0.005 )
		.group( 'Flowers' )
		.slider( 'flowerCount', 'flower count', tuned.flowerCount, 0, 4000, 50, 'rebuild' )
		.slider( 'flowerScale', 'flower size', tuned.flowerScale, 0.1, 2, 0.01, 'rebuild' )
		.slider( 'atlasCells', 'atlas cells', tuned.atlasCells, 1, 12, 1, 'rebuild' )
		.group( 'Assets' )
		.buttons( [
			{ label: 'Import hill', onClick: p => importTerrain( p ) },
			{ label: 'Export hill', onClick: () => exportGLB( terrainMesh ) }
		] )
		.buttons( [
			{ label: 'Import blade', onClick: p => importBlade( p ) },
			{ label: 'Export blade', onClick: p => exportPart( p, grass.bladeGeometry, 'grass-blade.glb' ) }
		] )
		.buttons( [
			{ label: 'Import tuft', onClick: p => importTuft( p ) },
			{ label: 'Export tuft', onClick: p => exportPart( p, grass.representativeTuft(), 'grass-tuft.glb' ) }
		] )
		.buttons( [
			{ label: 'Import flower sheet', onClick: p => importFlowerAtlas( p ) },
			{ label: 'Export flower sheet', onClick: p => exportFlowerAtlas( p ) }
		] )
		.buttons( [
			{ label: 'Import mountain', onClick: p => importMountain( p ) },
			{ label: 'Export mountain', onClick: p => exportPart( p, mountain.mesh && mountain.mesh.geometry, 'mountain.glb' ) }
		] )
		.buttons( [
			{ label: 'Import mountain map', onClick: p => importMountainMap( p ) },
			{ label: 'Export mountain map', onClick: p => exportMountainMap( p ) }
		] )
		.buttons( [
			{ label: 'Import cabin wall', onClick: p => importCabinPart( p, 'wall' ) },
			{ label: 'Export cabin wall', onClick: p => exportPart( p, cabin.wall && cabin.wall.geometry, 'cabin-wall.glb' ) }
		] )
		.buttons( [
			{ label: 'Import cabin door', onClick: p => importCabinPart( p, 'door' ) },
			{ label: 'Export cabin door', onClick: p => exportPart( p, cabin.door && cabin.door.geometry, 'cabin-door.glb' ) }
		] )
		.buttons( [
			{ label: 'Import wall paint', onClick: p => importCabinMap( p, 'wall' ) },
			{ label: 'Export wall paint', onClick: p => exportCabinMap( p, 'wall' ) }
		] )
		.buttons( [
			{ label: 'Import door paint', onClick: p => importCabinMap( p, 'door' ) },
			{ label: 'Export door paint', onClick: p => exportCabinMap( p, 'door' ) }
		] )
		.note( 'Requirements for imported files', [
			'<b>Hill</b> &mdash; <code>.glb</code>. Y up, Z forward (Blender glTF default). Position and size are free: the stage the terrain maps cover is fitted to the mesh on import, so an off-centre sculpt still gets colour and grass edge to edge. Keep height within roughly <code>&plusmn;1</code> unit &mdash; blades are only 0.08&ndash;0.30 tall and that ratio is what sells the scale. The fog box stays on the origin, so a hill far from it hazes lopsidedly until the fog sliders are retuned. Apply modifiers, export normals.',
			'<b>Blade</b> &mdash; <code>.glb</code>, one small mesh. Model a <i>single</i> blade standing on the origin and pointing +Y. Size and position do not matter: it is re-based to 0&ndash;1 in Y on import, because the shader uses <code>position.y</code> directly as the bend ratio. Keep it very low poly &mdash; this is drawn 150k+ times; the original is 7 vertices. Flat cards work best. Two-sided is automatic.',
			'<b>Tuft</b> &mdash; <code>.glb</code>. <b>One</b> clump of tall grass, standing on the origin pointing +Y, re-based the same way. Export gives you a single clump for exactly this reason: whatever you send back is treated as one tuft and scattered, so do not model a whole field. A few hundred vertices is fine; it is drawn a few thousand times, and total tuft vertices are capped, so a heavy clump lowers the count that fits. Silhouette matters more than detail &mdash; this is what breaks the skyline.',
			'<b>Flower sheet</b> &mdash; <code>.png</code> with alpha. A single horizontal strip of flowers, evenly divided, each cell drawn on a quad standing on its base. Export gives you the current sheet (750&times;256, 5 cells) to paint over. Set <i>atlas cells</i> to however many are in your strip. Each cell is about 3:5, taller than wide. Transparent background &mdash; anything under 0.4% alpha is discarded.',
			'<b>Mountain</b> &mdash; <code>.glb</code>, <b>UV mapped</b> (the import is refused without one). Unlike the blade and tuft it is <i>not</i> rescaled: its real size sets how big it reads in frame, so model it at roughly <code>8</code> units across and <code>3.5</code> tall and stand it on the origin pointing +Y. Detail belongs in the map, not the mesh &mdash; it sits 12 units away behind haze. Importing one retires the width/height/flank sliders.',
			'<b>Mountain map</b> &mdash; <code>.png</code>, cylindrical unwrap: <code>u</code> goes around the cone, <code>v</code> runs base&rarr;summit. Export gives you the generated one (1024&times;512) to paint over. Paint it <i>dark</i> &mdash; the beauty pass is near-black by design and the grade is what lifts it, so a map painted at normal screen brightness comes out blown.',
			'<b>Cabin wall / door</b> &mdash; <code>.glb</code>, <b>UV mapped</b>. Not rescaled: model the wall standing <i>on</i> the origin (its base at y&nbsp;=&nbsp;0, not centred on it) and the door as a flat leaf facing +Z, roughly <code>0.33 &times; 0.78</code> units to match the generated pair. The door is a separate mesh because it is the click target &mdash; keep it separate. Importing either retires the size sliders for that piece.',
			'<b>Wall / door paint</b> &mdash; <code>.png</code>. Export gives you the generated maps to paint over. The door map is the whole leaf: architrave, panels, grain, the sun and the handle, with <code>u</code> across and <code>v</code> bottom&rarr;top. Paint <i>dark and heavily saturated</i> &mdash; the grade screens a cyan tint over every pixel, so a red that looks right in Photoshop arrives on screen as dusty pink.',
			'Exports carry position and normals only. Internal attributes are stripped, because three writes anything it does not recognise as an integer custom accessor and Blender refuses the file when it meets one.',
			'Imports are live and temporary &mdash; nothing is written to the project. To keep one, hand the file to the developer; the hill also loads automatically from <code>assets/models/terrain_custom.glb</code>.'
		] )
		.actions( { onImport: importConfig, onPaste: pasteConfig } );

	// start frozen, matching the toggle's default
	cameraRig.shakeStrength = 0;
	cameraRig.lookStrength = 0;

}

/**
 * Widens the scatter to whatever the loaded mesh actually covers.
 *
 * The 4.7 default belongs to the procedural hill, whose rim deliberately droops into the
 * fog — grass thinning over the last unit is the point there. A sculpted hill normally
 * fills the stage, and that same taper then strips grass from everything past |x| or
 * |z| = 3.6 and all of it past 4.7, leaving the background slopes bare.
 *
 * Must run on *every* path that swaps the terrain. It originally lived inline in build(),
 * which only runs at page load, so importing a hill at runtime kept the procedural rim
 * and the edges stayed bald — the exact symptom this was meant to fix.
 */
function deriveScatterExtent() {

	const box = surface.boundingBox;
	const half = stage.size * 0.5;

	rimRadius = half;

	// Clamped to the stage as well as the mesh. deriveStage() fits the box around the mesh,
	// so this is a no-op in practice — it only bites if a caller scatters against a stage
	// that was fitted to some other terrain.
	scatterBounds = {
		minX: Math.max( stage.centre.x - half, box.min.x ),
		maxX: Math.min( stage.centre.x + half, box.max.x ),
		minZ: Math.max( stage.centre.y - half, box.min.z ),
		maxZ: Math.min( stage.centre.y + half, box.max.z )
	};

	// A sculpted hill has a real edge rather than a drooping rim, so the long fade that
	// suits the procedural one just leaves a bald ring.
	rimFade = 0.2;

	tuned.grassExtent = rimRadius;
	tuned.rimFade = rimFade;

	if ( panel ) {

		// The slider is authored for the procedural hill; re-range it before pushing the
		// fitted value or the input clamps it and the outer band goes bald on first touch.
		panel.range( 'grassExtent', 0.5, rimRadius );
		panel.set( 'grassExtent', rimRadius );
		panel.set( 'rimFade', rimFade );

	}

	return { rimRadius };

}

/**
 * The box the scatter actually fills.
 *
 * deriveScatterExtent() fits `scatterBounds` to the mesh, and `bounds` wins over
 * `rimRadius` inside scatterOnSurface — which quietly made the "grass extent" slider do
 * nothing on a sculpted hill. Intersecting the two gives the slider its meaning back:
 * at its default it is half the stage and changes nothing, and pulling it down draws the
 * meadow in from every side at once.
 */
function scatterArea() {

	if ( ! scatterBounds ) return null;

	const cx = stage.centre.x;
	const cz = stage.centre.y;

	return {
		minX: Math.max( scatterBounds.minX, cx - rimRadius ),
		maxX: Math.min( scatterBounds.maxX, cx + rimRadius ),
		minZ: Math.max( scatterBounds.minZ, cz - rimRadius ),
		maxZ: Math.min( scatterBounds.maxZ, cz + rimRadius )
	};

}

function updateStatus() {

	statusEl.textContent = ( usingCustomTerrain ? 'sculpted hill' : 'procedural hill' ) +
		' · ' + grass.bladeCount.toLocaleString() + ' blades' +
		' · ' + grass.tuftCount + ' tufts' +
		' · ' + flowers.count + ' flowers' +
		' · ' + insects.insects.length + ' insects';

}

/* ── asset imports ─────────────────────────────────────────────────────────── */

async function readGLB( panel, label ) {

	const file = await pickFile( '.glb,.gltf' );
	if ( ! file ) return null;

	panel.say( 'loading ' + file.name + '…' );

	try {

		return await parseGLB( await file.arrayBuffer() );

	} catch ( error ) {

		console.error( error );
		panel.say( label + ' failed: ' + error.message );
		return null;

	}

}

/**
 * Swapping the hill invalidates everything seated on it, so the surface sampler, the
 * baked rock/AO/albedo maps and all three scatters are rebuilt against the new geometry.
 */
/**
 * Swaps in a new terrain and rebuilds everything that sits on it.
 *
 * Split out of the file-picker handler so the swap can be driven directly — from the
 * console, or a test — without going through a file dialog. Everything downstream of the
 * terrain has to be redone: the surface sampler, the baked colour/rock/AO maps, the
 * scatter extent, and then the grass, flowers and insects that are seated on it.
 */
export async function installTerrain( geometry ) {

	geometry.computeBoundingBox();
	const size = geometry.boundingBox.getSize( new THREE.Vector3() );

	surface = new TerrainSurface( geometry );

	deriveStage();

	const maps = bakeTerrainMaps(
		surface.rasterize( MAP_RESOLUTION, stage.size, stage.centre.x, stage.centre.y ) );
	uniforms.u_terrainGrassTexture.value = maps.grassTexture;
	uniforms.u_terrainInfoTexture.value = maps.infoTexture;
	uniforms.u_terrainAOTexture.value = maps.aoTexture;

	terrainMesh.geometry.dispose();
	terrainMesh.geometry = geometry;

	usingCustomTerrain = true;
	deriveScatterExtent();
	rebuildEverything();

	return { size, stageCentre: stage.centre.clone(), stageSize: stage.size };

}

async function importTerrain( panel ) {

	const geometry = await readGLB( panel, 'Hill' );
	if ( ! geometry ) return;

	const { size, stageCentre } = await installTerrain( geometry );

	const offset = Math.hypot( stageCentre.x, stageCentre.y );

	// The terrain maps and the scatter follow the mesh now, but the fog box does not — it
	// is still an SDF centred on the origin, because where the haze sits is a look decision
	// rather than a property of the mesh. An off-centre hill therefore fogs asymmetrically,
	// which is worth saying rather than leaving them to wonder.
	panel.say( offset > 0.25
		? `Hill loaded (${size.x.toFixed( 1 )}×${size.z.toFixed( 1 )} units), centred at x ${stageCentre.x.toFixed( 1 )}, z ${stageCentre.y.toFixed( 1 )}. Maps and grass follow it; the fog box stays on the origin, so tune fog if the haze looks lopsided.`
		: `Hill loaded (${size.x.toFixed( 1 )}×${size.z.toFixed( 1 )} units). Grass extent set to ${rimRadius.toFixed( 1 )}.` );

}

async function importBlade( panel ) {

	const geometry = await readGLB( panel, 'Blade' );
	if ( ! geometry ) return;

	grass.bladeGeometry = normaliseProp( geometry );
	scheduleRebuild( 'grass' );

	panel.say( `Blade loaded (${geometry.attributes.position.count} verts).` );

}

async function importTuft( panel ) {

	const geometry = await readGLB( panel, 'Tuft' );
	if ( ! geometry ) return;

	grass.tuftGeometry = ensureYRatio( normaliseProp( geometry ) );
	scheduleRebuild( 'grass' );

	panel.say( `Tuft loaded (${geometry.attributes.position.count} verts).` );

}

async function importMountain( panel ) {

	const geometry = await readGLB( panel, 'Mountain' );
	if ( ! geometry ) return;

	// Kept unnormalised, unlike the blade and tuft: the cone's real size is what sets its
	// angular size in frame, and rescaling it to a unit box would throw that away.
	if ( ! geometry.attributes.uv ) {

		panel.say( 'Mountain needs a UV map — the albedo is sampled from it. Unwrap it in Blender and re-export.' );
		return;

	}

	mountainGeometry = geometry;
	buildMountain();

	geometry.computeBoundingBox();
	const size = geometry.boundingBox.getSize( new THREE.Vector3() );
	panel.say( `Mountain loaded (${size.x.toFixed( 1 )}×${size.y.toFixed( 1 )}×${size.z.toFixed( 1 )} units). The width/height/flank sliders no longer apply — reload to go back to the generated cone.` );

}

async function importMountainMap( panel ) {

	const file = await pickFile( 'image/*' );
	if ( ! file ) return;

	try {

		mountainMap = await loadImageTexture( file );
		mountainMap.wrapS = THREE.RepeatWrapping;
		buildMountain();
		panel.say( 'Mountain map loaded — the snow line slider no longer applies.' );

	} catch ( error ) {

		console.error( error );
		panel.say( 'Mountain map failed to load.' );

	}

}

async function exportMountainMap( panel ) {

	try {

		const { width, height } = await exportTexturePNG( mountain.map, 'mountain-map.png' );
		panel.say( `Saved mountain-map.png (${width}x${height}).` );

	} catch ( error ) {

		console.error( error );
		panel.say( 'Export failed: ' + error.message );

	}

}

async function importCabinPart( panel, which ) {

	const geometry = await readGLB( panel, which === 'wall' ? 'Cabin wall' : 'Cabin door' );
	if ( ! geometry ) return;

	if ( ! geometry.attributes.uv ) {

		panel.say( 'That mesh has no UV map — the paint is sampled from it. Unwrap it in Blender and re-export.' );
		return;

	}

	// Kept at its authored size and origin, like the mountain and unlike the blade: the
	// cabin's real dimensions are what set how big it reads, and the door has to line up
	// with the hole in the wall.
	if ( which === 'wall' ) cabinWallGeometry = geometry;
	else cabinDoorGeometry = geometry;

	buildCabin();

	geometry.computeBoundingBox();
	const size = geometry.boundingBox.getSize( new THREE.Vector3() );
	panel.say( `Cabin ${which} loaded (${size.x.toFixed( 2 )}×${size.y.toFixed( 2 )}×${size.z.toFixed( 2 )} units). Its size sliders no longer apply — reload to go back to the generated one.` );

}

async function importCabinMap( panel, which ) {

	const file = await pickFile( 'image/*' );
	if ( ! file ) return;

	try {

		const map = await loadImageTexture( file );

		if ( which === 'wall' ) cabinWallMap = map;
		else cabinDoorMap = map;

		buildCabin();
		panel.say( `Cabin ${which} map loaded — the sliders that paint it no longer apply.` );

	} catch ( error ) {

		console.error( error );
		panel.say( 'Cabin map failed to load.' );

	}

}

async function exportCabinMap( panel, which ) {

	const mesh = which === 'wall' ? cabin.wall : cabin.door;
	if ( ! mesh ) return panel.say( 'nothing to export yet' );

	try {

		const name = 'cabin-' + which + '.png';
		const { width, height } = await exportTexturePNG( mesh.material.uniforms.u_map.value, name );
		panel.say( `Saved ${name} (${width}x${height}).` );

	} catch ( error ) {

		console.error( error );
		panel.say( 'Export failed: ' + error.message );

	}

}

async function importFlowerAtlas( panel ) {

	const file = await pickFile( 'image/*' );
	if ( ! file ) return;

	try {

		flowerTexture = await loadImageTexture( file );
		scheduleRebuild( 'flowers' );
		panel.say( 'Flower sheet loaded — set "atlas cells" to match.' );

	} catch ( error ) {

		console.error( error );
		panel.say( 'Flower sheet failed to load.' );

	}

}

/**
 * Reads a config back in, so a tuning session survives a reload and can be handed around.
 *
 * Accepts either artefact the panel produces: the .js paste block or a plain JSON dump.
 * Rather than parse JavaScript, it pulls `key: number` pairs out with a regex and keeps
 * the ones it recognises — tolerant of comments, trailing commas and the array syntax in
 * the camera block, none of which JSON.parse would survive.
 */
/**
 * Body of `export const NAME = { … };`.
 *
 * Non-greedy up to a `};` at the start of a line, so the inline braces on MOUNTAIN's
 * `wide:` / `narrow:` rows do not end the block early.
 */
function configBlock( text, name ) {

	// Plain string search rather than a built RegExp: `'\\s'` inside a JS string literal is
	// just `s`, so a dynamically assembled pattern here silently matches nothing and every
	// block-scoped value quietly falls back to its default.
	const start = text.indexOf( 'const ' + name );
	if ( start < 0 ) return '';

	const open = text.indexOf( '{', start );
	const end = text.indexOf( '\n};', open );

	if ( open < 0 || end < 0 ) return '';

	// Strip nested objects. MOUNTAIN's wide/narrow layouts carry their own `width` and
	// `height`, and a flat scan lets those shadow the cone's — the last one wins, so the
	// mountain came back 0.94 units tall on every config import.
	return text.slice( open + 1, end ).replace( /\{[^{}]*\}/g, '' );

}

/** `key: number` pairs out of one block, renamed through `aliases` on the way. */
function scalarsFrom( source, aliases = {} ) {

	const out = {};

	for ( const match of source.matchAll( /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(-?[\d.]+)/g ) ) {

		out[ aliases[ match[ 1 ] ] || match[ 1 ] ] = Number( match[ 2 ] );

	}

	return out;

}

function applyConfigText( panel, text, source ) {

	try {

		// Loose pass first, for the camera and grade values that sit outside any block, then
		// each block on its own. Blocks have to be scoped: FOG and MOUNTAIN both carry a
		// `radius`, and a flat scan would let whichever appears last silently win.
		const numbers = scalarsFrom( text );

		Object.assign( numbers,
			scalarsFrom( configBlock( text, 'FOG' ), {
				boxSize: 'fogBox', start: 'fogStart', range: 'fogRange'
			} ),
			scalarsFrom( configBlock( text, 'RESPONSIVE' ), {
				minHorizontalFov: 'minHFov'
			} ),
			scalarsFrom( configBlock( text, 'MOUNTAIN' ), {
				distance: 'mountainDistance', summitY: 'mountainSummitY', radius: 'mountainRadius',
				height: 'mountainHeight', profile: 'mountainProfile', ridgeAmount: 'mountainRidge',
				snowLine: 'mountainSnowLine', rockWarmth: 'mountainRockWarmth',
				tongueLength: 'mountainTongueLength', tongueCount: 'mountainTongueCount',
				baseMist: 'mountainBaseMist', baseMistHeight: 'mountainBaseMistHeight',
				exposure: 'mountainExposure', haze: 'mountainHaze',
				lightTint: 'mountainLightTint'
			} ) );

		// the camera block stores arrays, not scalars
		const position = text.match( /position:\s*\[([^\]]+)\]/ );
		const rotation = text.match( /rotation:\s*\[([^\]]+)\]/ );
		const toNumbers = m => m[ 1 ].split( ',' ).map( v => Number( v.trim() ) );

		if ( position ) {

			const [ x, y, z ] = toNumbers( position );
			Object.assign( numbers, { posX: x, posY: y, posZ: z } );

		}

		if ( rotation ) {

			const [ pitch, yaw ] = toNumbers( rotation );
			Object.assign( numbers, { pitch, yaw } );

		}

		// FOG.centre is an array too, and the scalar regex above skips it — without this the
		// fog centre silently reverts to the origin on every config import.
		const centre = text.match( /centre:\s*\[([^\]]+)\]/ );

		if ( centre ) {

			const [ x, z ] = toNumbers( centre );
			Object.assign( numbers, { fogCentreX: x, fogCentreZ: z } );

		}

		let applied = 0;
		for ( const key in tuned ) {

			if ( numbers[ key ] === undefined || ! Number.isFinite( numbers[ key ] ) ) continue;
			tuned[ key ] = numbers[ key ];
			panel.set( key, numbers[ key ] );
			applied ++;

		}

		if ( applied === 0 ) {

			panel.say( 'Nothing recognised in that file.' );
			return;

		}

		applyTunedCamera();
		applyTunedFog();
		buildMountain();

		scheduleRebuild( 'grass' );
		setTimeout( () => scheduleRebuild( 'flowers' ), 320 );

		panel.say( `Applied ${applied} values from ${source}.` );

	} catch ( error ) {

		console.error( error );
		panel.say( 'Import failed: ' + error.message );

	}

}

async function importConfig( panel ) {

	const file = await pickFile( '.js,.json,.txt' );
	if ( ! file ) return;

	applyConfigText( panel, await file.text(), file.name );

}

/**
 * Reads a config out of the clipboard, falling back to whatever is in the textarea.
 *
 * Clipboard reads need both permission and a real user gesture, and are refused outright
 * in some contexts — so the textarea below the buttons is editable and doubles as the
 * manual route: paste there, press the same button.
 */
async function pasteConfig( panel ) {

	let text = '';

	try {

		text = await navigator.clipboard.readText();

	} catch ( error ) {

		text = '';

	}

	if ( ! text.trim() ) {

		text = panel.textarea ? panel.textarea.value : '';

		if ( ! text.trim() ) {

			panel.say( 'Clipboard unavailable — paste the config into the box below, then press this again.' );
			if ( panel.textarea ) panel.textarea.focus();
			return;

		}

		applyConfigText( panel, text, 'the box below' );
		return;

	}

	applyConfigText( panel, text, 'clipboard' );

}

async function exportFlowerAtlas( panel ) {

	try {

		const { width, height } = await exportTexturePNG( flowerTexture, 'flower-sheet.png' );
		panel.say( `Saved flower-sheet.png (${width}x${height}).` );

	} catch ( error ) {

		console.error( error );
		panel.say( 'Export failed: ' + error.message );

	}

}

async function exportPart( panel, geometry, filename ) {

	if ( ! geometry ) return panel.say( 'nothing to export yet' );

	panel.say( 'exporting…' );

	try {

		await exportGeometryGLB( geometry, filename );
		panel.say( 'Saved ' + filename + '.' );

	} catch ( error ) {

		console.error( error );
		panel.say( 'Export failed: ' + error.message );

	}

}

/** Re-seat everything that sits on the terrain. */
function rebuildEverything() {

	grass.dispose();
	grass.build( surface, {
		rimRadius,
		rimFade,
		maxSlope,
		bounds: scatterArea(),
		bladeCount: tuned.bladeCount,
		bladeWidthScale: tuned.bladeWidthScale,
		bladeHeightScale: tuned.bladeHeightScale,
		tuftInstances: tuned.tuftInstances,
		tuftScale: tuned.tuftScale
	} );

	flowers.dispose();
	flowers.build( surface, flowerTexture, {
		rimRadius,
		rimFade,
		maxSlope,
		bounds: scatterArea(),
		flowerCount: tuned.flowerCount,
		flowerScale: tuned.flowerScale,
		atlasCells: tuned.atlasCells
	} );

	insects.container.clear();
	insects.insects.length = 0;
	insects.build( surface, INSECTS );

	updateStatus();

}

/* ── mountain ──────────────────────────────────────────────────────────────── */

// Artist overrides. Null means "generate it", and the generated one is disposed on every
// rebuild while an imported one is kept.
let mountainGeometry = null;
let mountainMap = null;

let cabinWallGeometry = null;
let cabinDoorGeometry = null;
let cabinWallMap = null;
let cabinDoorMap = null;

function buildMountain() {

	mountain.build( Object.assign( {}, MOUNTAIN, {
		geometry: mountainGeometry,
		map: mountainMap,
		radius: tuned.mountainRadius,
		height: tuned.mountainHeight,
		profile: tuned.mountainProfile,
		ridgeAmount: tuned.mountainRidge,
		snowLine: tuned.mountainSnowLine,
		rockWarmth: tuned.mountainRockWarmth,
		tongueLength: tuned.mountainTongueLength,
		tongueCount: tuned.mountainTongueCount,
		baseMist: tuned.mountainBaseMist,
		baseMistHeight: tuned.mountainBaseMistHeight,
		lightWrap: tuned.mountainLightWrap,
		snowBrightness: tuned.mountainSnowBrightness,
		snowShade: tuned.mountainSnowShade,
		rockContrast: tuned.mountainRockContrast,
		exposure: tuned.mountainExposure,
		haze: tuned.mountainHaze,
		lightTint: tuned.mountainLightTint
	} ) );

	placeMountain();

}

/**
 * Vertical fov that holds a minimum *horizontal* fov.
 *
 * three's fov is vertical, so a narrow viewport crops the sides rather than zooming out,
 * and the mountain and cabin fall out of frame on a phone. Widening the vertical fov is
 * the only way to buy horizontal room back. Clamped below by the hero shot's own fov, so
 * a wide desktop viewport keeps exactly the framing everything else was tuned against.
 */
function fovForAspect( aspect ) {

	const safe = Number.isFinite( aspect ) && aspect > 0 ? aspect : 1;
	const halfH = THREE.MathUtils.degToRad( tuned.minHFov ) * 0.5;
	const needed = THREE.MathUtils.radToDeg(
		2 * Math.atan( Math.tan( halfH ) / Math.max( 0.05, safe ) ) );

	return THREE.MathUtils.clamp( needed, tuned.fov, tuned.maxFov );

}

/** Interpolates the mountain's framing between the wide and narrow layouts. */
function mountainLayout( aspect ) {

	const wide = MOUNTAIN.wide;
	const narrow = MOUNTAIN.narrow;
	const t = THREE.MathUtils.clamp(
		( wide.aspect - aspect ) / ( wide.aspect - narrow.aspect ), 0, 1 );

	return {
		anchorX: THREE.MathUtils.lerp( wide.anchorX, narrow.anchorX, t ),
		width: THREE.MathUtils.lerp( wide.width, narrow.width, t ),
		height: THREE.MathUtils.lerp( wide.height, narrow.height, t )
	};

}

function buildCabin() {

	cabin.build( Object.assign( {}, CABIN, {
		wallGeometry: cabinWallGeometry,
		doorGeometry: cabinDoorGeometry,
		wallMap: cabinWallMap,
		doorMap: cabinDoorMap,
		width: tuned.cabinWidth,
		height: tuned.cabinHeight,
		depth: tuned.cabinDepth,
		doorWidth: tuned.cabinDoorWidth,
		doorHeight: tuned.cabinDoorHeight,
		doorOffsetX: tuned.cabinDoorOffsetX,
		ornamentSize: tuned.cabinOrnamentSize,
		ornamentRays: Math.round( tuned.cabinOrnamentRays ),
		ornamentSwirl: tuned.cabinOrnamentSwirl,
		lampSize: tuned.cabinLampSize,
		weathering: tuned.cabinWeathering,
		grain: tuned.cabinGrain,
		exposure: tuned.cabinExposure,
		lightWrap: tuned.cabinLightWrap,
		lightTint: tuned.cabinLightTint,
		faceTint: tuned.cabinFaceTint
	} ) );

	placeCabin();

}

/** Same wide/narrow interpolation the mountain uses. */
function layoutFor( config, aspect ) {

	const t = THREE.MathUtils.clamp(
		( config.wide.aspect - aspect ) / ( config.wide.aspect - config.narrow.aspect ), 0, 1 );

	return {
		anchorX: THREE.MathUtils.lerp( config.wide.anchorX, config.narrow.anchorX, t ),
		scale: THREE.MathUtils.lerp( config.wide.scale, config.narrow.scale, t )
	};

}

function placeCabin() {

	if ( ! cabin.wall ) return;

	const aspect = Number.isFinite( camera.aspect ) && camera.aspect > 0 ? camera.aspect : 1;
	const layout = layoutFor( CABIN, aspect );

	cabin.place( {
		position: cameraRig.basePosition,
		quaternion: cameraRig.baseQuaternion,
		fov: camera.fov,
		aspect
	}, surface, {
		anchorX: layout.anchorX,
		scale: layout.scale,
		distance: tuned.cabinDistance,
		yaw: tuned.cabinYaw,
		sink: tuned.cabinSink
	} );

}

function placeMountain() {

	const aspect = Number.isFinite( camera.aspect ) && camera.aspect > 0 ? camera.aspect : 1;
	const layout = mountainLayout( aspect );

	// Solved against the rig's *anchor*, not the live camera: the rig adds shake and
	// mouse-look every frame, and re-solving against those would glue the mountain to the
	// camera and kill the parallax that is the whole point of it being geometry.
	mountain.place( {
		position: cameraRig.basePosition,
		quaternion: cameraRig.baseQuaternion,
		fov: camera.fov,
		aspect
	}, {
		anchorX: layout.anchorX,
		distance: tuned.mountainDistance,
		// Solved from the summit so the peak sits at the same world height however narrow
		// the viewport gets and whatever cone an artist has imported.
		baseY: tuned.mountainSummitY - mountain.modelHeight() * layout.height,
		width: layout.width,
		height: layout.height
	} );

}

/** Push the tuned fog/haze values into the shared uniforms. */
function applyTunedFog() {

	uniforms.u_fogBox.value.set( tuned.fogBox, tuned.fogBox );
	uniforms.u_fogCentre.value.set( tuned.fogCentreX, tuned.fogCentreZ );
	uniforms.u_fogStart.value = tuned.fogStart;
	uniforms.u_fogRange.value = tuned.fogRange;
	uniforms.u_hazeStart.value = tuned.hazeStart;
	uniforms.u_hazeRange.value = tuned.hazeRange;
	uniforms.u_hazeAmount.value = tuned.hazeAmount;

}

function applyShot() {

	const g = SHOT.grade;

	cameraRig.setAnchor( SHOT.camera );
	placeMountain();
	placeCabin();
	cameraRig.lookStrength = g.cameraLookStrength;
	cameraRig.shakeStrength = g.cameraShakeStrength;

	bloom.amount = g.bloomAmount;
	bloom.radius = g.bloomRadius;
	bloom.threshold = g.bloomThreshold;
	bloom.smoothWidth = g.bloomSmoothWidth;
	bloom.haloWidth = g.haloWidth;
	bloom.haloRGBShift = g.haloRGBShift;
	bloom.haloStrength = g.haloStrength;
	bloom.haloMaskInner = g.haloMaskInner;
	bloom.haloMaskOuter = g.haloMaskOuter;

	grade.vignetteFrom = g.vignetteFrom;
	grade.vignetteTo = g.vignetteTo;
	grade.vignetteColor.setHex( g.vignetteColorHex );
	grade.saturation = g.saturation;
	grade.contrast = g.contrast;
	grade.brightness = g.brightness;
	grade.tintColor.setHex( g.tintColorHex );
	grade.tintOpacity = g.tintOpacity;

}

function bindInput() {

	window.addEventListener( 'keydown', event => {

		const key = event.key.toLowerCase();

		if ( key === 'r' ) applyShot();                        // back to the framing
		else if ( key === 'h' ) document.getElementById( 'hud' ).classList.toggle( 'is-visible' );
		else if ( key === 't' && panel ) panel.toggleVisibility();
		else if ( key === 'g' ) exportGLB( terrainMesh );       // hand off to Blender
		else if ( key === 'o' ) exportOBJ( terrainMesh );

	} );

	renderer.domElement.addEventListener( 'pointermove', event => {

		mousePixel.set( event.clientX, event.clientY );

	} );

	document.querySelectorAll( '[data-action]' ).forEach( button => {

		button.addEventListener( 'click', () => {

			const action = button.dataset.action;
			if ( action === 'glb' ) exportGLB( terrainMesh );
			else if ( action === 'obj' ) exportOBJ( terrainMesh );
			else if ( action === 'reset' ) applyShot();

		} );

	} );

}

/* ── resize ────────────────────────────────────────────────────────────────── */

let width = 1;
let height = 1;

function onResize() {

	const pixelRatio = renderer.getPixelRatio();

	width = Math.floor( window.innerWidth * pixelRatio );
	height = Math.floor( window.innerHeight * pixelRatio );

	// A zero-area viewport is real — a backgrounded tab, and the moment mid-orientation
	// change on mobile — and 0/0 puts NaN straight into the projection matrix, where it
	// stays until something happens to resize again.
	camera.aspect = window.innerHeight > 0 && window.innerWidth > 0
		? window.innerWidth / window.innerHeight
		: camera.aspect || 1;

	camera.fov = fovForAspect( camera.aspect );
	camera.updateProjectionMatrix();

	// Mountain and cabin are both framed in screen space, so a reshape moves them.
	placeMountain();
	placeCabin();

	renderer.setSize( window.innerWidth, window.innerHeight );
	sceneTarget.setSize( width, height );
	bloomTarget.setSize( width, height );
	bloom.setSize( width, height );

}

/* ── frame ─────────────────────────────────────────────────────────────────── */

let lastTime = 0;

function updateInteractionField() {

	if ( ! terrainMesh ) return;

	raycaster.setFromCamera( cameraRig.mouseXY, camera );

	const hits = raycaster.intersectObject( terrainMesh );

	if ( hits.length > 0 ) {

		hitPoint.copy( hits[ 0 ].point );
		drawMaterial.uniforms.u_mouseXZ.value.set( hitPoint.x, hitPoint.z );
		drawMaterial.uniforms.u_mouseStrength.value = Math.min( 1, mousePixel.distanceTo( prevMousePixel ) / 5 );

	} else {

		drawMaterial.uniforms.u_mouseStrength.value = 0;

	}

	prevMousePixel.copy( mousePixel );

	const write = 1 - drawRead;
	drawMaterial.uniforms.u_texture.value = drawTargets[ drawRead ].texture;
	FboHelper.render( renderer, drawMaterial, drawTargets[ write ] );
	drawRead = write;

	uniforms.u_terrainDrawTexture.value = drawTargets[ write ].texture;

}

function animate() {

	requestAnimationFrame( animate );

	const now = performance.now() / 1000;
	const dt = Math.min( now - lastTime, 1 / 20 );
	lastTime = now;

	frame( dt );

}

function frame( dt ) {

	uniforms.u_time.value += dt;

	cameraRig.update( dt );
	insects.update( dt );

	// The sky sphere is only radius 15 against a far plane of 20, so it rides with the
	// camera rather than enclosing the world.
	skyMesh.position.copy( camera.position );

	updateInteractionField();

	renderer.setRenderTarget( sceneTarget );
	renderer.clear( true, true, true );
	renderer.render( scene, camera );

	bloom.render( renderer, sceneTarget.texture, bloomTarget );
	grade.render( renderer, bloomTarget.texture, width, height, null );

	renderer.setRenderTarget( null );

}
