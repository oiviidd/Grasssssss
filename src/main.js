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
import { fogChunk, dayNightUniforms } from './glsl/fog.js';
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
import { Cabin, markDetails, bakeDetailShadow } from './Cabin.js';
import { DayNight } from './DayNight.js';
import { Intro, waitForTitleFonts } from './Intro.js';
import { SHOT, INTRO, INSECTS, GRASS, FOG, MOUNTAIN, MOUNTAIN_BLOCKOUT, CABIN, CABIN_BLOCKOUT, RESPONSIVE } from './shot.js';
import { TweakPanel } from './TweakPanel.js';
import { pickFile, parseGLB, parseGLBWithMap, preloadDecoder, normaliseProp, ensureYRatio, loadImageTexture, exportGeometryGLB, exportTexturePNG } from './AssetIO.js';

// The fog/sky chunk is shared by ShaderMaterial and RawShaderMaterial alike — three
// resolves #include for both.
THREE.ShaderChunk.lusionFog = fogChunk;

const MODEL_PATH = 'assets/models/';
const TEXTURE_PATH = 'assets/textures/';
const CUSTOM_TERRAIN = MODEL_PATH + 'terrain_custom.glb';

// The artist's mountain and cabin, loaded at startup when present. Either one missing just
// leaves the generated blockout in its place.
const CUSTOM_MOUNTAIN = MODEL_PATH + 'mountain_custom.glb';
const CUSTOM_CABIN = MODEL_PATH + 'cabin_custom.glb';

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
// Far plane well past the sky: the sky is a backdrop that never occludes (see below), so
// this is what limits how far back the mountain can stand.
const camera = new THREE.PerspectiveCamera( 30, 1, 0.05, 120 );
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
	u_stageSize: { value: stage.size },

	// Time of day (DayNight.js, read in glsl/fog.js). All neutral here: white tint and
	// ambient, no glow, no moon, lamp dark — the daylight shot.
	u_skyTint: { value: new THREE.Vector3( 1, 1, 1 ) },
	u_ambient: { value: new THREE.Vector3( 1, 1, 1 ) },
	u_desaturate: { value: 0 },
	u_sunDir: { value: new THREE.Vector3( 0, 1, 0 ) },
	u_sunGlow: { value: new THREE.Vector3() },
	u_moonDir: { value: new THREE.Vector3( 0, 1, 0 ) },
	u_moonGlow: { value: new THREE.Vector3() },
	u_moon: { value: 0 },
	u_stars: { value: 0 },
	u_lampPosition: { value: new THREE.Vector3() },
	u_lampNormal: { value: new THREE.Vector3( 0, 0, 1 ) },
	u_lampWall: { value: 0.15 },
	u_lampColor: { value: new THREE.Vector3() },
	u_lampRange: { value: 0.6 }
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

/**
 * Whether images can be decoded off the main thread, with their options honoured. Safari
 * before 17 and Firefox before 98 take createImageBitmap but ignore or mishandle the flip
 * and alpha options, so they keep the plain <img> route.
 */
const DECODE_OFF_THREAD = typeof createImageBitmap === 'function' && ( () => {

	const ua = navigator.userAgent;
	const safari = /^((?!chrome|android).)*safari/i.test( ua ) ? parseInt( ( ua.match( /Version\/(\d+)/ ) || [] )[ 1 ], 10 ) : null;
	const firefox = ua.indexOf( 'Firefox' ) > - 1 ? parseInt( ( ua.match( /Firefox\/(\d+)/ ) || [] )[ 1 ], 10 ) : null;
	return ! ( safari !== null && safari < 17 ) && ! ( firefox !== null && firefox < 98 );

} )();

/**
 * One of the scene's textures, decoded as an ImageBitmap where the browser can.
 *
 * An <img> is decoded on the main thread the first time it is drawn, which put the 4K sky
 * — half a second of it — into the very first frame. createImageBitmap decodes in the
 * background while the rest loads. The flip and the straight (unpremultiplied) alpha that
 * WebGL would otherwise apply at upload are done at decode instead; the result was checked
 * texel for texel against the <img> route on every texture loaded here.
 */
async function loadTexture( file, options ) {

	const { flipY = true, wrap = null, minFilter = null } = options || {};

	let texture;

	if ( DECODE_OFF_THREAD ) {

		const response = await fetch( TEXTURE_PATH + file );
		if ( ! response.ok ) throw new Error( TEXTURE_PATH + file + ' → ' + response.status );

		const image = await createImageBitmap( await response.blob(),
			Object.assign( { premultiplyAlpha: 'none' }, flipY ? { imageOrientation: 'flipY' } : {} ) );

		texture = new THREE.Texture( image );
		texture.flipY = false; // already applied
		// so an export can turn the picture back the right way up (r122 textures have no
		// userData of their own)
		texture.userData = Object.assign( texture.userData || {}, { flippedAtDecode: flipY } );
		texture.needsUpdate = true;

	} else {

		texture = await new Promise( ( resolve, reject ) => {

			const t = textureLoader.load( TEXTURE_PATH + file, () => resolve( t ), undefined, reject );
			t.flipY = flipY;

		} );

	}

	if ( wrap ) texture.wrapS = texture.wrapT = wrap;

	if ( minFilter ) {

		texture.minFilter = minFilter;
		texture.generateMipmaps = false;

	} else {

		texture.minFilter = THREE.LinearMipMapLinearFilter;
		texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

	}

	return texture;

}

const grass = new Grass( uniforms );
const flowers = new Flowers( uniforms );
const mountain = new Mountain( uniforms );
const cabin = new Cabin( uniforms );
// Opens at the light over Damavand at this moment, Iran time, and holds it there.
const dayNight = new DayNight( uniforms, { tintHex: SHOT.grade.tintColorHex } ).syncToSun( new Date() );
const intro = new Intro( document.getElementById( 'intro' ), INTRO );

/**
 * An optional hand-off: null when the file is not there, the parsed prop when it is.
 * Checked with HEAD first so a missing file costs one tiny request, not a failed download.
 */
async function loadOptionalProp( url ) {

	try {

		const head = await fetch( url, { method: 'HEAD' } );
		if ( ! head.ok ) return null;

		return await parseGLBWithMap( await ( await fetch( url ) ).arrayBuffer() );

	} catch ( error ) {

		// A broken hand-off must not take the whole page down with it.
		console.error( url, error );
		return null;

	}

}

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
	[ 'customTerrain', () => loadCustomTerrain( CUSTOM_TERRAIN ).catch( () => null ) ],
	// the artist's mountain and cabin, each null when not dropped in
	[ 'customMountain', () => loadOptionalProp( CUSTOM_MOUNTAIN ) ],
	[ 'customCabin', () => loadOptionalProp( CUSTOM_CABIN ) ],
	// the opening title's typefaces, so it never reveals in a fallback and swaps mid-way
	[ 'fonts', () => waitForTitleFonts() ]
];

let completed = 0;

// The Draco decoder is warmed up while the models download, so their meshes are in the
// workers the moment they land.
preloadDecoder().catch( error => console.warn( 'Draco decoder preload failed', error ) );

const loading = {};

for ( const [ key, run ] of jobs ) {

	loading[ key ] = run().then( value => {

		completed ++;
		loaderBarEl.style.transform = 'scaleX(' + ( completed / jobs.length ) + ')';
		return value;

	} );

}

/** The named jobs' results, as one { key: value } once they have all come in. */
function gather( keys ) {

	return Promise.all( keys.map( key => loading[ key ] ) )
		.then( values => Object.fromEntries( keys.map( ( key, i ) => [ key, values[ i ] ] ) ) );

}

// The mountain and the cabin are the slow part — their meshes decode for a second in Draco's
// workers — and nothing else waits on them. So the rest of the world is built on the main
// thread while they decode, instead of after; the page appears no differently, just sooner.
const PROPS = [ 'customMountain', 'customCabin', 'fonts' ];

gather( jobs.map( ( [ key ] ) => key ).filter( key => ! PROPS.includes( key ) ) )
	.then( assets => buildWorld( assets ).then( () => gather( PROPS ) ).then( props => Object.assign( assets, props ) ) )
	.then( assets => buildProps( assets ) )
	.catch( error => {

		console.error( error );
		loaderEl.innerHTML = '<p class="loader-error">Assets failed to load.<br>Serve this folder over HTTP — see README.md.</p>';

	} );

/* ── scene construction ────────────────────────────────────────────────────── */

/**
 * Lets queued work run before the next long step. The models' loader needs a few short turns
 * on the main thread to hand their meshes to the decoder; a half-second terrain bake that
 * started first used to hold them back until it was done, and the decode then began late.
 */
const nextTask = () => new Promise( resolve => setTimeout( resolve, 0 ) );

/** Everything but the mountain and the cabin: sky, hill, grass, flowers, insects. */
async function buildWorld( assets ) {

	await nextTask();

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

	await nextTask();

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
				u_moon: uniforms.u_moon,
				u_stars: uniforms.u_stars,
				u_envTexture: uniforms.u_envTexture,
				u_fogBox: uniforms.u_fogBox,
				u_fogCentre: uniforms.u_fogCentre,
				u_fogRadius: uniforms.u_fogRadius,
				u_fogStart: uniforms.u_fogStart,
				u_fogRange: uniforms.u_fogRange,
				u_hazeStart: uniforms.u_hazeStart,
				u_hazeRange: uniforms.u_hazeRange,
				u_hazeAmount: uniforms.u_hazeAmount,
				...dayNightUniforms( uniforms )
			},
			vertexShader: skyVert,
			fragmentShader: skyFrag,
			side: THREE.BackSide,
			// A backdrop, not a wall. Writing depth at radius 15 cut off anything past it —
			// pushing the mountain further back sliced its far side away, so it had to stay
			// close enough to sink into the meadow's ridge instead.
			depthWrite: false,
			depthTest: false
		} )
	);
	skyMesh.frustumCulled = false;
	// Drawn before everything, the terrain's -1000 included, so the rest paints over it.
	skyMesh.renderOrder = - 2000;
	scene.add( skyMesh );

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
			...dayNightUniforms( uniforms ),
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

	await nextTask();

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

	insects.build( surface, INSECTS, { avoid: insectNoFlyZones() } );
	scene.add( insects.container );

	// Opened after dusk, the day's insects are already gone for the night.
	dayNight.update( 0, heroView() );
	insects.setPresent( dayNight.insectsOut, { immediate: true } );

}

/** The mountain and the cabin, once they have decoded — then the page starts. */
function buildProps( assets ) {

	/* the mountain and the cabin ---------------------------------------------- */

	// The artist's hand-offs, when present, replace the blockouts before anything is built.
	// Adopted as they are: exposure, scale and framing come from the config — the values the
	// sliders tune and Copy config saves. Fitting belongs to an interactive import only; doing
	// it here would overwrite the saved tuning on every page load.
	if ( assets.customMountain ) installMountainAsset( assets.customMountain, { fit: false, rebuild: false } );
	if ( assets.customCabin ) installCabinAsset( assets.customCabin, 'wall', { fit: false, rebuild: false } );

	// Without the artist's model the blockout comes back, and it needs its own look: its maps
	// are painted near-black for the grade to lift, and it is lit by the sky rather than baked.
	// Taking the artist model's tuning instead would draw it washed out and flat.
	if ( ! assets.customMountain ) {

		setTuned( 'mountainExposure', MOUNTAIN_BLOCKOUT.exposure );
		setTuned( 'mountainUnlit', MOUNTAIN_BLOCKOUT.unlit );
		setTuned( 'mountainScale', 1 );

	}

	if ( ! assets.customCabin ) {

		setTuned( 'cabinExposure', CABIN_BLOCKOUT.exposure );
		setTuned( 'cabinUnlit', CABIN_BLOCKOUT.unlit );
		setTuned( 'cabinScale', 1 );
		setTuned( 'cabinScreenX', 0 );

	}

	buildMountain();
	scene.add( mountain.container );

	buildCabin();
	scene.add( cabin.container );

	/* go ---------------------------------------------------------------------- */

	applyShot();
	onResize();
	window.addEventListener( 'resize', onResize );
	bindInput();
	buildTweakPanel( assets.flowers );

	updateStatus();

	// Before the first frame, so the page never flashes the hero shot first.
	intro.start();

	loaderEl.classList.add( 'is-hidden' );

	// One menu: the HUD's status, hand-off buttons and key list live inside the tweak panel,
	// and both stay hidden until the unlock sequence in bindInput().
	panel.adopt( document.getElementById( 'hud' ) );

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
		installMountainAsset,
		installCabinAsset,
		get mountain() { return mountain; },
		get cabin() { return cabin; },
		tuned,
		dayNight,
		intro,
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
	mountainBaseMist: MOUNTAIN.baseMist,
	mountainBaseMistHeight: MOUNTAIN.baseMistHeight,
	mountainScale: MOUNTAIN.modelScale !== undefined ? MOUNTAIN.modelScale : 1,
	mountainUnlit: MOUNTAIN.unlit !== undefined ? MOUNTAIN.unlit : 0,
	mountainScreenX: MOUNTAIN.screenX !== undefined ? MOUNTAIN.screenX : 0,

	cabinDistance: CABIN.distance,
	cabinYaw: CABIN.yaw,
	cabinSink: CABIN.sink,
	cabinExposure: CABIN.exposure,
	cabinScale: CABIN.modelScale !== undefined ? CABIN.modelScale : 1,
	cabinUnlit: CABIN.unlit !== undefined ? CABIN.unlit : 0,
	cabinScreenX: CABIN.screenX !== undefined ? CABIN.screenX : 0,
	mountainExposure: MOUNTAIN.exposure,
	mountainHaze: MOUNTAIN.haze,

	phoneZoom: RESPONSIVE.phoneZoom,
	tabletZoom: RESPONSIVE.tabletZoom,

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

	// Anything that sets the camera outright ends the opening where it stands.
	intro.finish();

	cameraRig.setAnchor( {
		position: [ tuned.posX, tuned.posY, tuned.posZ ],
		rotation: [ tuned.pitch, tuned.yaw, 0 ],
		cameraDistance: SHOT.camera.cameraDistance
	} );

	applyLens();

	placeMountain();
	placeCabin();

}

/* ── Blender-style navigation ──────────────────────────────────────────────── */

const _navEuler = new THREE.Euler();
const _navQuat = new THREE.Quaternion();
const _navForward = new THREE.Vector3();
const _navRight = new THREE.Vector3();

const flyKeys = new Set();
const FLY_KEYS = new Set( [ 'w', 'a', 's', 'd', 'q', 'e', 'shift' ] );
const FLY_SPEED = 1.2; // units per second; Shift triples it

// What navigation changes, and so what the reset key restores.
const VIEW_KEYS = [ 'posX', 'posY', 'posZ', 'pitch', 'yaw', 'fov',
	'mountainDistance', 'mountainScreenX', 'cabinDistance', 'cabinScreenX' ];
let homeView = null;

// Set by the menu's unlock sequence (see bindInput); until then nothing moves the camera.
let unlocked = false;

function snapshotView() {

	return Object.fromEntries( VIEW_KEYS.map( key => [ key, tuned[ key ] ] ) );

}

/** Back to the view the page opened with. */
function resetView() {

	if ( ! homeView ) return;
	for ( const key of VIEW_KEYS ) setTuned( key, homeView[ key ] );
	applyTunedCamera();

}

/** Keys typed into the config box or a text field must not fly the camera or reset it. */
function isTypingTarget( el ) {

	if ( ! el ) return false;
	if ( el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ) return true;
	return el.tagName === 'INPUT' && ! /^(range|checkbox|radio|button)$/.test( el.type );

}

/** The camera's own axes from the tuned pitch and yaw, in the rig's rotation order. */
function viewAxes() {

	_navEuler.set( tuned.pitch, tuned.yaw, 0, 'YXZ' );
	_navQuat.setFromEuler( _navEuler );

	return {
		forward: new THREE.Vector3( 0, 0, - 1 ).applyQuaternion( _navQuat ),
		right: new THREE.Vector3( 1, 0, 0 ).applyQuaternion( _navQuat ),
		up: new THREE.Vector3( 0, 1, 0 ).applyQuaternion( _navQuat )
	};

}

/**
 * Re-expresses a prop's world position as the anchor parameters placement reads, against the
 * camera as it is *now*.
 *
 * The mountain and cabin are framed relative to the camera, which is what keeps them on
 * screen as the viewport changes shape. It also means a moving camera drags them along, and
 * navigating would feel as if the world were glued to the lens. Solving the anchor back from
 * where they stand keeps them fixed in the world while you fly, the way Blender does, and
 * what Copy config saves then reproduces the view exactly.
 */
function rebaseProp( world, layout, distanceKey, screenKey ) {

	const q = cameraRig.baseQuaternion;
	const forward = _navForward.set( 0, 0, - 1 ).applyQuaternion( q );
	const right = _navRight.set( 1, 0, 0 ).applyQuaternion( q );

	forward.y = 0;
	right.y = 0;
	if ( forward.lengthSq() < 1e-6 ) forward.set( 0, 0, - 1 );
	forward.normalize();
	right.normalize();

	const dx = world.x - cameraRig.basePosition.x;
	const dz = world.z - cameraRig.basePosition.z;
	const distance = dx * forward.x + dz * forward.z;
	const lateral = dx * right.x + dz * right.z;

	const aspect = Number.isFinite( camera.aspect ) && camera.aspect > 0 ? camera.aspect : 1;
	const span = distance * Math.tan( THREE.MathUtils.degToRad( camera.fov ) * 0.5 ) * aspect;

	// The screen offset fades out on phone layouts, so there it cannot carry a position —
	// and a phone-shaped window is not where a shot gets framed anyway.
	const fade = 1 - layout.t;
	if ( Math.abs( span ) < 1e-6 || fade < 0.05 ) return;

	setTuned( distanceKey, distance );
	setTuned( screenKey, ( lateral / span - layout.anchorX ) / fade );

}

/**
 * The one door every camera change goes through — sliders, keys, mouse. `change` edits the
 * tuned camera; the mountain and the cabin are held where they stand in the world.
 */
function moveCamera( change ) {

	// The edit is made to the hero shot, so the opening has to be out of the way first.
	intro.finish();

	const mountainAt = mountain.mesh ? mountain.container.position.clone() : null;
	const cabinAt = cabin.wall ? cabin.container.position.clone() : null;

	change();

	cameraRig.setAnchor( {
		position: [ tuned.posX, tuned.posY, tuned.posZ ],
		rotation: [ tuned.pitch, tuned.yaw, 0 ],
		cameraDistance: SHOT.camera.cameraDistance
	} );

	// The fov has to be current before solving: the anchor is a share of it.
	applyLens();

	const aspect = Number.isFinite( camera.aspect ) && camera.aspect > 0 ? camera.aspect : 1;
	if ( mountainAt ) rebaseProp( mountainAt, mountainLayout( aspect ), 'mountainDistance', 'mountainScreenX' );
	if ( cabinAt ) rebaseProp( cabinAt, layoutFor( CABIN, aspect ), 'cabinDistance', 'cabinScreenX' );

	for ( const key of [ 'posX', 'posY', 'posZ', 'pitch', 'yaw' ] ) setTuned( key, tuned[ key ] );

	applyTunedCamera();

}

/** Middle-drag: turn around a pivot `cameraDistance` in front, as Blender's orbit does. */
function orbit( dx, dy ) {

	moveCamera( () => {

		const d = SHOT.camera.cameraDistance;
		const pivot = new THREE.Vector3( tuned.posX, tuned.posY, tuned.posZ )
			.addScaledVector( viewAxes().forward, d );

		tuned.yaw -= dx * 0.005;
		tuned.pitch = THREE.MathUtils.clamp( tuned.pitch - dy * 0.005, - 1.45, 1.45 );

		const forward = viewAxes().forward;
		tuned.posX = pivot.x - forward.x * d;
		tuned.posY = pivot.y - forward.y * d;
		tuned.posZ = pivot.z - forward.z * d;

	} );

}

/** Shift + middle-drag: slide the view in its own plane — drag right and the scene follows. */
function pan( dx, dy ) {

	moveCamera( () => {

		const { right, up } = viewAxes();
		const k = 0.0025 * SHOT.camera.cameraDistance;

		tuned.posX += ( - dx * right.x + dy * up.x ) * k;
		tuned.posY += ( - dx * right.y + dy * up.y ) * k;
		tuned.posZ += ( - dx * right.z + dy * up.z ) * k;

	} );

}

/** Wheel, or Ctrl + middle-drag: straight along the view. */
function dolly( amount ) {

	moveCamera( () => {

		const { forward } = viewAxes();

		tuned.posX += forward.x * amount;
		tuned.posY += forward.y * amount;
		tuned.posZ += forward.z * amount;

	} );

}

/** W A S D along the ground and Q E straight down and up, for as long as they are held. */
function updateKeyboardFly( dt ) {

	if ( flyKeys.size === 0 ) return;

	const along = ( flyKeys.has( 'w' ) ? 1 : 0 ) - ( flyKeys.has( 's' ) ? 1 : 0 );
	const across = ( flyKeys.has( 'd' ) ? 1 : 0 ) - ( flyKeys.has( 'a' ) ? 1 : 0 );
	const rise = ( flyKeys.has( 'e' ) ? 1 : 0 ) - ( flyKeys.has( 'q' ) ? 1 : 0 );
	if ( ! along && ! across && ! rise ) return;

	const step = FLY_SPEED * dt * ( flyKeys.has( 'shift' ) ? 3 : 1 );

	moveCamera( () => {

		// The heading with the pitch taken out, so W runs over the meadow rather than into it.
		const { forward, right } = viewAxes();
		forward.y = 0;
		right.y = 0;
		if ( forward.lengthSq() < 1e-6 ) forward.set( 0, 0, - 1 );
		forward.normalize();
		right.normalize();

		tuned.posX += ( forward.x * along + right.x * across ) * step;
		tuned.posZ += ( forward.z * along + right.z * across ) * step;
		tuned.posY += rise * step;

	} );

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
	distance: ${f( tuned.mountainDistance, 3 )},
	summitY: ${f( tuned.mountainSummitY, 2 )},
	modelScale: ${f( tuned.mountainScale, 2 )},
	screenX: ${f( tuned.mountainScreenX, 3 )},
	exposure: ${f( tuned.mountainExposure, 2 )},
	unlit: ${f( tuned.mountainUnlit, 2 )},
	haze: ${f( tuned.mountainHaze, 3 )},
	baseMist: ${f( tuned.mountainBaseMist, 2 )},
	baseMistHeight: ${f( tuned.mountainBaseMistHeight, 2 )},
	wide: { aspect: ${MOUNTAIN.wide.aspect}, anchorX: ${MOUNTAIN.wide.anchorX} },
	narrow: { aspect: ${MOUNTAIN.narrow.aspect}, anchorX: ${MOUNTAIN.narrow.anchorX} }
};

export const CABIN = {
	distance: ${f( tuned.cabinDistance, 3 )},
	yaw: ${f( tuned.cabinYaw, 3 )},
	sink: ${f( tuned.cabinSink, 3 )},
	modelScale: ${f( tuned.cabinScale, 2 )},
	screenX: ${f( tuned.cabinScreenX, 3 )},
	exposure: ${f( tuned.cabinExposure, 2 )},
	unlit: ${f( tuned.cabinUnlit, 2 )},
	wide: { aspect: ${CABIN.wide.aspect}, anchorX: ${CABIN.wide.anchorX}, scale: ${CABIN.wide.scale} },
	narrow: { aspect: ${CABIN.narrow.aspect}, anchorX: ${CABIN.narrow.anchorX}, scale: ${CABIN.narrow.scale} }
};

export const RESPONSIVE = {
	phoneAspect: ${RESPONSIVE.phoneAspect},
	phoneZoom: ${f( tuned.phoneZoom, 2 )},
	tabletAspect: ${RESPONSIVE.tabletAspect},
	tabletZoom: ${f( tuned.tabletZoom, 2 )},
	desktopAspect: ${RESPONSIVE.desktopAspect}
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

			// The clock: none of it is saved with the shot. Stopping it holds the light where it is.
			if ( key === 'dayNight' ) {

				setDayNight( value );
				return;

			}

			if ( key === 'daySpeed' ) {

				dayNight.speed = value;
				return;

			}

			if ( key === 'dayHour' ) {

				dayNight.hour = value;
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

			if ( key === 'phoneZoom' || key === 'tabletZoom' ) {

				applyTunedCamera();
				return;

			}

			if ( key === 'mountainDistance' || key === 'mountainSummitY' || key === 'mountainScale' || key === 'mountainScreenX' ) {

				placeMountain();
				return;

			}

			// Pure look — no geometry or map to regenerate, so push straight at the uniform.
			const liveMountain = {
				mountainExposure: 'u_exposure',
				mountainHaze: 'u_haze',
				mountainBaseMist: 'u_baseMist',
				mountainBaseMistHeight: 'u_baseMistHeight',
				mountainUnlit: 'u_unlit'
			};

			if ( liveMountain[ key ] ) {

				mountain.set( liveMountain[ key ], value );
				return;

			}

			if ( key === 'cabinDistance' || key === 'cabinYaw' || key === 'cabinSink' || key === 'cabinScale' || key === 'cabinScreenX' ) {

				placeCabin();
				return;

			}

			const liveCabin = {
				cabinExposure: 'u_exposure',
				cabinUnlit: 'u_unlit'
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
			// camera sliders: the mountain and cabin hold still in the world, as they do in flight
			else moveCamera( () => {} );

		}

	} );

	panel
		.toggle( 'freeze', 'Freeze camera (no shake / mouse-look)', true )
		.group( 'Intro' )
		.buttons( [
			{ label: 'Replay intro', onClick: () => intro.start() }
		] )
		.group( 'Day / night (test)' )
		.toggle( 'dayNight', 'Run the day / night cycle', dayNight.running )
		.slider( 'daySpeed', 'speed (game hours / sec)', dayNight.speed, 0, 24, 0.1 )
		.slider( 'dayHour', 'time of day (hour)', dayNight.hour, 0, 24, 0.01 )
		.group( 'Camera' )
		.slider( 'posX', 'position x', tuned.posX, - 15, 15, 0.01 )
		.slider( 'posY', 'position y', tuned.posY, - 2, 10, 0.01 )
		.slider( 'posZ', 'position z', tuned.posZ, - 15, 15, 0.01 )
		.slider( 'pitch', 'pitch', tuned.pitch, - 1.45, 1.45, 0.001 )
		.slider( 'yaw', 'yaw', tuned.yaw, - 3.14, 3.14, 0.001 )
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
		.slider( 'mountainDistance', 'distance', tuned.mountainDistance, 1, 40, 0.1 )
		.slider( 'mountainScale', 'mountain scale', tuned.mountainScale, 0.2, 3, 0.01 )
		.slider( 'mountainScreenX', 'mountain screen x', tuned.mountainScreenX, - 4, 4, 0.01 )
		.slider( 'mountainSummitY', 'peak height', tuned.mountainSummitY, - 1, 10, 0.05 )
		.slider( 'mountainBaseMist', 'base mist', tuned.mountainBaseMist, 0, 1, 0.01 )
		.slider( 'mountainBaseMistHeight', 'mist height', tuned.mountainBaseMistHeight, 0.05, 1, 0.01 )
		.slider( 'mountainExposure', 'brightness', tuned.mountainExposure, 0.1, 3, 0.05 )
		.slider( 'mountainHaze', 'haze', tuned.mountainHaze, 0, 1, 0.01 )
		.slider( 'mountainUnlit', 'mountain baked light', tuned.mountainUnlit, 0, 1, 0.01 )
		.group( 'Cabin' )
		.slider( 'cabinDistance', 'distance', tuned.cabinDistance, 0.3, 15, 0.05 )
		.slider( 'cabinScale', 'cabin scale', tuned.cabinScale, 0.2, 3, 0.01 )
		.slider( 'cabinScreenX', 'cabin screen x', tuned.cabinScreenX, - 4, 4, 0.01 )
		.slider( 'cabinYaw', 'turn', tuned.cabinYaw, - 1.4, 1.4, 0.01 )
		.slider( 'cabinSink', 'ground offset', tuned.cabinSink, - 2.5, 1, 0.01 )
		.slider( 'cabinExposure', 'brightness', tuned.cabinExposure, 0.2, 4, 0.05 )
		.slider( 'cabinUnlit', 'cabin baked light', tuned.cabinUnlit, 0, 1, 0.01 )
		.group( 'Responsive' )
		.slider( 'phoneZoom', 'phone zoom (1 = desktop, lower = wider)', tuned.phoneZoom, 0.3, 1.2, 0.01 )
		.slider( 'tabletZoom', 'tablet zoom (1 = desktop, lower = wider)', tuned.tabletZoom, 0.3, 1.2, 0.01 )
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
			{ label: 'Import cabin', onClick: p => importCabinPart( p, 'wall' ) },
			{ label: 'Export cabin', onClick: p => exportPart( p, cabin.wall && cabin.wall.geometry, 'cabin.glb' ) }
		] )
		.note( 'Requirements for imported files', [
			'<b>Hill</b> &mdash; <code>.glb</code>. Y up, Z forward (Blender glTF default). Position and size are free: the stage the terrain maps cover is fitted to the mesh on import, so an off-centre sculpt still gets colour and grass edge to edge. Keep height within roughly <code>&plusmn;1</code> unit &mdash; blades are only 0.08&ndash;0.30 tall and that ratio is what sells the scale. The fog box stays on the origin, so a hill far from it hazes lopsidedly until the fog sliders are retuned. Apply modifiers, export normals.',
			'<b>Blade</b> &mdash; <code>.glb</code>, one small mesh. Model a <i>single</i> blade standing on the origin and pointing +Y. Size and position do not matter: it is re-based to 0&ndash;1 in Y on import, because the shader uses <code>position.y</code> directly as the bend ratio. Keep it very low poly &mdash; this is drawn 150k+ times; the original is 7 vertices. Flat cards work best. Two-sided is automatic.',
			'<b>Tuft</b> &mdash; <code>.glb</code>. <b>One</b> clump of tall grass, standing on the origin pointing +Y, re-based the same way. Export gives you a single clump for exactly this reason: whatever you send back is treated as one tuft and scattered, so do not model a whole field. A few hundred vertices is fine; it is drawn a few thousand times, and total tuft vertices are capped, so a heavy clump lowers the count that fits. Silhouette matters more than detail &mdash; this is what breaks the skyline.',
			'<b>Flower sheet</b> &mdash; <code>.png</code> with alpha. A single horizontal strip of flowers, evenly divided, each cell drawn on a quad standing on its base. Export gives you the current sheet (750&times;256, 5 cells) to paint over. Set <i>atlas cells</i> to however many are in your strip. Each cell is about 3:5, taller than wide. Transparent background &mdash; anything under 0.4% alpha is discarded.',
			'<b>Mountain</b> &mdash; <code>.glb</code>, <b>UV mapped</b> (the import is refused without one). Unlike the blade and tuft it is <i>not</i> rescaled: its real size sets how big it reads in frame, so model it at roughly <code>8</code> units across and <code>3.5</code> tall and stand it on the origin pointing +Y. Detail belongs in the map, not the mesh &mdash; it sits 12 units away behind haze. Its own texture is used, and it is fitted to the blockout height on import.',
			'<b>Cabin</b> &mdash; <code>.glb</code>, <b>UV mapped</b>, Draco-compressed or not. It can be the whole building, door included: the generated roof, lamp and door are then hidden and the file\u2019s own texture is used if it carries one. It is seated on its lowest point, so where its origin sits does not matter. Size it with <i>cabin scale</i>.',
			'Exports carry position and normals only. Internal attributes are stripped, because three writes anything it does not recognise as an integer custom accessor and Blender refuses the file when it meets one.',
			'Imports are live and temporary &mdash; nothing is written to the project. To keep one, save it into <code>assets/models/</code> under the name that loads at startup: <code>terrain_custom.glb</code> for the hill, <code>mountain_custom.glb</code>, <code>cabin_custom.glb</code>. Every slider keeps working on a model that loaded at startup; <i>Copy config</i> into <code>src/shot.js</code> to keep the tuning.'
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
		' · ' + insects.insects.length + ' insects' +
		( mountainGeometry ? ' · artist mountain' : '' ) +
		( cabinWallGeometry ? ' · artist cabin' : '' );

}

/* ── asset imports ─────────────────────────────────────────────────────────── */

/** Like readGLB, but keeps UVs and the artist's own texture — for the mountain and cabin. */
async function readGLBWithMap( panel, label ) {

	const file = await pickFile( '.glb,.gltf' );
	if ( ! file ) return null;

	panel.say( 'loading ' + file.name + '…' );

	try {

		return await parseGLBWithMap( await file.arrayBuffer() );

	} catch ( error ) {

		console.error( error );
		panel.say( label + ' failed: ' + error.message );
		return null;

	}

}

/** Sets a tuned value and moves its slider to match, when the panel exists. */
function setTuned( key, value ) {

	tuned[ key ] = value;
	if ( panel ) panel.set( key, value );

}

/**
 * A warning when a hand-off is heavier than a home page can comfortably carry. The meadow
 * already draws around 185k blades, so these budgets are for the prop alone.
 */
function heavyWarning( triangles, budget ) {

	return triangles > budget
		? ` That is ${ ( triangles / budget ).toFixed( 1 ) }\u00d7 the ${ Math.round( budget / 1000 ) }k budget for this piece \u2014 decimate it in Blender before it ships.`
		: '';

}

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

/**
 * Full anisotropic filtering on an artist's map. Without it the cabin's side wall, which the
 * camera sees at a grazing angle, drops to a mip level picked for its steepest axis and
 * reads as a smear; the texture itself is 4K and has the detail.
 */
function sharpen( map ) {

	map.anisotropy = renderer.capabilities.getMaxAnisotropy();
	map.needsUpdate = true;
	return map;

}

/**
 * Swaps in an artist's mountain. Split from the file picker, like installTerrain, so a file
 * can be pushed in from the console or a test without a dialog.
 */
export function installMountainAsset( { geometry, map, baked, triangles }, { fit = true, rebuild = true } = {} ) {

	if ( ! geometry.attributes.uv ) {

		return { ok: false, message: 'Mountain needs a UV map \u2014 its paint is sampled from it. Unwrap it in Blender and re-export.' };

	}

	mountainGeometry = geometry;

	// Fitted to the generated cone's height, so the framing tuned against it carries over.
	// Shown on the "mountain scale" slider rather than applied silently, so it can be undone.
	geometry.computeBoundingBox();
	const tall = geometry.boundingBox.max.y - geometry.boundingBox.min.y;
	if ( fit && tall > 1e-6 ) setTuned( 'mountainScale', + ( MOUNTAIN_BLOCKOUT.height / tall ).toFixed( 2 ) );

	// The artist's own painting wins over the procedural one. Without a texture in the file
	// the generated map is simply wrapped onto their mesh.
	if ( map ) mountainMap = sharpen( map );

	// Lighting painted into the texture is drawn flat rather than lit a second time, and at a
	// lower exposure: a baked texture is an ordinary-brightness image, while the procedural map
	// is painted near-black for the grade to lift. Measured on mount.glb against the reference
	// snow [222,231,240]: 1.0 lands at [227,241,250] with nothing clipped; the procedural 1.7
	// clipped 45% of the snow to flat white.
	if ( baked && fit ) {

		setTuned( 'mountainUnlit', 1 );
		setTuned( 'mountainExposure', 1 );

	}

	if ( rebuild ) buildMountain();

	geometry.computeBoundingBox();
	const size = geometry.boundingBox.getSize( new THREE.Vector3() );

	return {
		ok: true,
		message: `Mountain loaded (${size.x.toFixed( 1 )}\u00d7${size.y.toFixed( 1 )}\u00d7${size.z.toFixed( 1 )} units, ${Math.round( triangles ).toLocaleString()} triangles${map ? ( baked ? ', with its own baked-lighting texture, drawn unlit' : ', with its own texture' ) : ''}).` +
			heavyWarning( triangles, 150000 ) +
			' Size it with "mountain scale".'
	};

}

async function importMountain( panel ) {

	const asset = await readGLBWithMap( panel, 'Mountain' );
	if ( asset ) panel.say( installMountainAsset( asset ).message );

}

/**
 * Swaps in an artist's cabin or door. `which` is 'wall' for the building — which may well be
 * the whole cabin, door and all — or 'door' for a door modelled as a separate leaf.
 */
export function installCabinAsset( { geometry, map, baked, triangles, parts }, which = 'wall', { fit = true, rebuild = true } = {} ) {

	if ( ! geometry.attributes.uv ) {

		return { ok: false, message: 'That mesh has no UV map \u2014 its paint is sampled from it. Unwrap it in Blender and re-export.' };

	}

	// Seated by its own lowest point. The generated cabin is built standing on its origin, but
	// a hand-off is usually modelled around its centre — cabin.glb runs y -0.58 .. 1.05 — and
	// taking it as-is buries the bottom third in the meadow.
	geometry.computeBoundingBox();
	geometry.translate( 0, - geometry.boundingBox.min.y, 0 );
	geometry.computeBoundingBox();

	if ( which === 'wall' ) {

		cabinWallGeometry = geometry;

		// The emblem on the door travels in the same file; it gets its relief and shadow back.
		if ( cabinDetail && cabinDetail.mask ) cabinDetail.mask.dispose();
		cabinDetail = markDetails( geometry, parts );
		if ( cabinDetail ) cabinDetail.mask = bakeDetailShadow( renderer, geometry, cabinDetail );

		// Fitted to the blockout's height, so every framing tuned against it — desktop and phone
		// alike — carries over. cabin.glb stands 1.63 units to the blockout's 1.35, and at full
		// size it filled the entire phone frame, mountain included.
		const tall = geometry.boundingBox.max.y - geometry.boundingBox.min.y;
		if ( fit && tall > 1e-6 ) setTuned( 'cabinScale', + ( CABIN_BLOCKOUT.height / tall ).toFixed( 2 ) );
		if ( map ) cabinWallMap = sharpen( map );

		// Same reasoning as the mountain. Measured on cabin.glb: 0.5 puts the wall at
		// [119,68,70] against the reference [118,41,48] and the door at [40,61,66] against
		// [44,50,57]; the procedural 1.6 turned the red to salmon, [248,141,130].
		if ( baked && fit ) {

			setTuned( 'cabinUnlit', 1 );
			setTuned( 'cabinExposure', 0.5 );

		}

	} else {

		cabinDoorGeometry = geometry;
		if ( map ) cabinDoorMap = sharpen( map );

	}

	if ( rebuild ) buildCabin();

	const size = geometry.boundingBox.getSize( new THREE.Vector3() );

	return {
		ok: true,
		message: `${which === 'wall' ? 'Cabin' : 'Cabin door'} loaded (${size.x.toFixed( 2 )}\u00d7${size.y.toFixed( 2 )}\u00d7${size.z.toFixed( 2 )} units, ${Math.round( triangles ).toLocaleString()} triangles${map ? ( baked ? ', with its own baked-lighting texture, drawn unlit' : ', with its own texture' ) : ''}).` +
			heavyWarning( triangles, 100000 ) +
			( which === 'wall'
				? ` Scaled ×${ tuned.cabinScale } to the blockout’s height. The generated roof, lamp and door are hidden; the door stays as an invisible click target.`
				: ' Its size sliders no longer apply.' )
	};

}

async function importCabinPart( panel, which ) {

	const asset = await readGLBWithMap( panel, which === 'wall' ? 'Cabin' : 'Cabin door' );
	if ( asset ) panel.say( installCabinAsset( asset, which ).message );

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
	const start = text.indexOf( 'const ' + name + ' =' );
	if ( start < 0 ) return '';

	const open = text.indexOf( '{', start );
	const end = text.indexOf( '\n};', open );

	if ( open < 0 || end < 0 ) return '';

	// Strip nested objects. The wide/narrow layouts carry keys of their own, and a flat scan
	// lets those shadow the block's — the last one wins. MOUNTAIN's once carried `width` and
	// `height`, and the mountain came back 0.94 units tall on every config import.
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
			scalarsFrom( configBlock( text, 'RESPONSIVE' ) ),
			scalarsFrom( configBlock( text, 'MOUNTAIN' ), {
				distance: 'mountainDistance', summitY: 'mountainSummitY', modelScale: 'mountainScale',
				screenX: 'mountainScreenX', exposure: 'mountainExposure', unlit: 'mountainUnlit',
				haze: 'mountainHaze', baseMist: 'mountainBaseMist', baseMistHeight: 'mountainBaseMistHeight'
			} ),
			scalarsFrom( configBlock( text, 'CABIN' ), {
				distance: 'cabinDistance', yaw: 'cabinYaw', sink: 'cabinSink', modelScale: 'cabinScale',
				screenX: 'cabinScreenX', exposure: 'cabinExposure', unlit: 'cabinUnlit'
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
		buildCabin();

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
	insects.build( surface, INSECTS, { avoid: insectNoFlyZones() } );

	updateStatus();

}

/* ── mountain ──────────────────────────────────────────────────────────────── */

// Artist overrides. Null means "generate it", and the generated one is disposed on every
// rebuild while an imported one is kept.
let mountainGeometry = null;
let mountainMap = null;

let cabinWallGeometry = null;
let cabinDoorGeometry = null;
let cabinDetail = null;
let cabinWallMap = null;
let cabinDoorMap = null;

function buildMountain() {

	// Shape and paint come from the blockout definition and only show if the artist's model
	// is missing; the look is the tuned values the sliders drive.
	mountain.build( Object.assign( {}, MOUNTAIN_BLOCKOUT, {
		geometry: mountainGeometry,
		map: mountainMap,
		exposure: tuned.mountainExposure,
		unlit: tuned.mountainUnlit,
		haze: tuned.mountainHaze,
		baseMist: tuned.mountainBaseMist,
		baseMistHeight: tuned.mountainBaseMistHeight
	} ) );

	placeMountain();

}

/**
 * How far the camera zooms out for a viewport shape: 1 is the hero framing, lower sees more.
 *
 * three's fov is vertical, so a narrow viewport crops the sides rather than zooming out,
 * and the mountain and cabin fall out of frame on a phone. The zoom is tuned at a phone
 * and a tablet shape (RESPONSIVE in shot.js) and blended by aspect; from the desktop
 * shape up it is 1, so a wide viewport keeps exactly the framing everything else was
 * tuned against. Narrower than the phone it shrinks with the aspect, which holds the
 * phone's horizontal view.
 */
function zoomForAspect( aspect ) {

	const safe = Number.isFinite( aspect ) && aspect > 0 ? aspect : 1;
	const { phoneAspect, tabletAspect, desktopAspect } = RESPONSIVE;
	const { phoneZoom, tabletZoom } = tuned;
	const between = ( from, to ) => THREE.MathUtils.clamp( ( safe - from ) / ( to - from ), 0, 1 );

	if ( safe >= desktopAspect ) return 1;
	if ( safe >= tabletAspect ) return THREE.MathUtils.lerp( tabletZoom, 1, between( tabletAspect, desktopAspect ) );
	if ( safe >= phoneAspect ) return THREE.MathUtils.lerp( phoneZoom, tabletZoom, between( phoneAspect, tabletAspect ) );
	return Math.max( 0.1, phoneZoom * safe / phoneAspect );

}

/**
 * Sets the camera's lens for the current viewport: the zoom, and a shift that holds the
 * bottom edge of the frame where the hero shot has it.
 *
 * A plain wider fov opens the frame evenly above and below, and below is the underside of
 * the meadow's near edge — it showed as a strip of sky under the grass on a phone. The
 * view offset is a lens shift, not a tilt: the camera still looks level, so nothing leans,
 * and the extra room all goes into the sky.
 */
function applyLens( baseFov = tuned.fov ) {

	const aspect = viewAspect();
	const lens = lensFor( aspect, baseFov );

	camera.fov = lens.fov;

	if ( lens.shift > 1e-4 ) camera.setViewOffset( aspect, 1, 0, - lens.shift, aspect, 1 );
	else camera.clearViewOffset();

	camera.updateProjectionMatrix();

}

/**
 * The lens for a viewport shape, starting from `baseFov` — the hero's, or the opening's on
 * its way down. `shift` is the lift as a share of the frame's height: the bottom edge sits
 * (1 - zoom) / 2 of it lower than the hero's would, so the frame is raised by exactly that.
 */
function lensFor( aspect, baseFov ) {

	const zoom = zoomForAspect( aspect );
	const halfTan = Math.tan( THREE.MathUtils.degToRad( baseFov ) * 0.5 );

	return {
		fov: THREE.MathUtils.clamp( THREE.MathUtils.radToDeg( 2 * Math.atan( halfTan / zoom ) ), 1, 150 ),
		shift: ( 1 - Math.min( zoom, 1 ) ) * 0.5
	};

}

function viewAspect() {

	return Number.isFinite( camera.aspect ) && camera.aspect > 0 ? camera.aspect : 1;

}

const _heroPosition = new THREE.Vector3();
const _heroQuaternion = new THREE.Quaternion();
const _heroEuler = new THREE.Euler();

/**
 * The framing the mountain, the cabin and the sky are laid out against: the tuned hero
 * shot. Not the rig's live anchor — the opening flies that, and props solved against it
 * would ride along with the camera instead of standing still while it moves.
 */
function heroView() {

	const aspect = viewAspect();

	_heroPosition.set( tuned.posX, tuned.posY, tuned.posZ );
	_heroEuler.set( tuned.pitch, tuned.yaw, 0, 'YXZ' );
	_heroQuaternion.setFromEuler( _heroEuler );

	return {
		position: _heroPosition,
		quaternion: _heroQuaternion,
		fov: lensFor( aspect, tuned.fov ).fov,
		aspect
	};

}

/** The hero shot as a pose the opening can fly to. */
function heroPose() {

	return {
		position: [ tuned.posX, tuned.posY, tuned.posZ ],
		rotation: [ tuned.pitch, tuned.yaw, 0 ],
		fov: tuned.fov
	};

}

/** Interpolates the mountain's framing between the wide and narrow layouts. */
function mountainLayout( aspect ) {

	const wide = MOUNTAIN.wide;
	const narrow = MOUNTAIN.narrow;
	const t = THREE.MathUtils.clamp(
		( wide.aspect - aspect ) / ( wide.aspect - narrow.aspect ), 0, 1 );

	return {
		t,
		anchorX: THREE.MathUtils.lerp( wide.anchorX, narrow.anchorX, t )
	};

}

function buildCabin() {

	cabin.build( Object.assign( {}, CABIN_BLOCKOUT, {
		wallGeometry: cabinWallGeometry,
		doorGeometry: cabinDoorGeometry,
		wallMap: cabinWallMap,
		doorMap: cabinDoorMap,
		exposure: tuned.cabinExposure,
		unlit: tuned.cabinUnlit,
		lampPosition: CABIN.lampPosition,
		lampWall: CABIN.lampWall,
		detail: cabinDetail,
		detailShadow: CABIN.emblemShadow,
		detailContact: CABIN.emblemContact,
		detailShadowOffset: CABIN.emblemShadowOffset,
		detailRelief: CABIN.emblemRelief
	} ) );

	placeCabin();

}

/** Same wide/narrow interpolation the mountain uses. */
function layoutFor( config, aspect ) {

	const t = THREE.MathUtils.clamp(
		( config.wide.aspect - aspect ) / ( config.wide.aspect - config.narrow.aspect ), 0, 1 );

	return {
		t,
		anchorX: THREE.MathUtils.lerp( config.wide.anchorX, config.narrow.anchorX, t ),
		scale: THREE.MathUtils.lerp( config.wide.scale, config.narrow.scale, t )
	};

}

function placeCabin() {

	if ( ! cabin.wall ) return;

	const view = heroView();
	const layout = layoutFor( CABIN, view.aspect );

	cabin.place( view, surface, {
		// A nudge for the desktop composition the reference was drawn for. It fades out toward
		// phone layouts, which have their own anchor: applied in full, a desktop nudge dragged
		// the imported cabin to the middle of the phone frame, where it hid the mountain.
		anchorX: layout.anchorX + tuned.cabinScreenX * ( 1 - layout.t ),
		scale: layout.scale * tuned.cabinScale,
		distance: tuned.cabinDistance,
		yaw: tuned.cabinYaw,
		sink: tuned.cabinSink
	} );

}

/**
 * Where the insects may not fly: around the lens, where a sprite one unit away fills a
 * third of the frame, and the cabin's own footprint, so nothing passes through its walls.
 * Live references, so a moved camera or a re-placed cabin needs no rebuild — `object` is a
 * getter because importing a cabin rebuilds its wall mesh.
 */
function insectNoFlyZones() {

	return [
		{ position: cameraRig.basePosition, radius: 2.2 },
		// margin covers the sprite's own half-width and the wobble the quad adds on top
		{ get object() { return cabin.wall; }, margin: 0.18 }
	];

}

function placeMountain() {

	const view = heroView();
	const layout = mountainLayout( view.aspect );

	// Solved against the hero shot, not the live camera: the rig adds shake and mouse-look
	// every frame and the opening flies it, and re-solving against either would glue the
	// mountain to the camera and kill the parallax that is the whole point of it being geometry.
	mountain.place( view, {
		// A nudge for the desktop composition the reference was drawn for. It fades out toward
		// phone layouts, which have their own anchor: applied in full, a desktop nudge dragged
		// the imported cabin to the middle of the phone frame, where it hid the mountain.
		anchorX: layout.anchorX + tuned.mountainScreenX * ( 1 - layout.t ),
		distance: tuned.mountainDistance,
		// Solved from the summit so the peak sits at the same world height whatever cone an
		// artist has imported and however it is scaled.
		baseY: tuned.mountainSummitY - mountain.modelTop() * tuned.mountainScale,
		scale: tuned.mountainScale
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

	homeView = snapshotView();

	// Enter Enter K M Enter Enter opens the menu. Nothing on the page hints at it, and every
	// way of moving the camera — keys, scroll, middle-drag — and every shortcut stays dead
	// until it has been typed, so a visitor who scrolls is not dollied out of the shot, W
	// does not fly them off and G does not hand them a terrain download. Once unlocked they
	// stay live for the rest of the visit, menu open or hidden.
	const UNLOCK = [ 'enter', 'enter', 'k', 'm', 'enter', 'enter' ];
	const recent = [];

	// Space twice in quick succession sets the day / night clock running or stops it — for
	// every visitor, menu or not.
	const DOUBLE_SPACE = 400; // ms between the two presses
	let lastSpace = - Infinity;

	// A click, tap or key while the title is up sends the camera on its way now.
	window.addEventListener( 'pointerdown', () => intro.skip() );

	window.addEventListener( 'keydown', event => {

		if ( isTypingTarget( event.target ) ) return;

		intro.skip();

		const key = event.key.toLowerCase();

		if ( key === ' ' ) {

			// No page scroll, and no click on whichever menu control still has focus — that
			// would toggle the cycle's own checkbox a second time.
			event.preventDefault();
			if ( document.activeElement && document.activeElement !== document.body ) document.activeElement.blur();

			if ( ! event.repeat ) {

				if ( event.timeStamp - lastSpace < DOUBLE_SPACE ) {

					lastSpace = - Infinity;
					setDayNight( ! dayNight.running );

				} else {

					lastSpace = event.timeStamp;

				}

			}

		}

		if ( ! event.repeat ) {

			recent.push( key );
			if ( recent.length > UNLOCK.length ) recent.shift();

			if ( panel && recent.length === UNLOCK.length && recent.every( ( k, i ) => k === UNLOCK[ i ] ) ) {

				recent.length = 0;
				unlocked = true;
				panel.show();
				return;

			}

		}

		if ( ! unlocked ) return;

		if ( FLY_KEYS.has( key ) ) flyKeys.add( key );

		if ( key === 'r' ) resetView();                        // back to the framing
		else if ( key === 'g' ) exportGLB( terrainMesh );       // hand off to Blender
		else if ( key === 'o' ) exportOBJ( terrainMesh );

	} );

	renderer.domElement.addEventListener( 'pointermove', event => {

		mousePixel.set( event.clientX, event.clientY );

	} );

	window.addEventListener( 'keyup', event => flyKeys.delete( event.key.toLowerCase() ) );

	// A key released while the window is not focused never reports its keyup.
	window.addEventListener( 'blur', () => flyKeys.clear() );

	const canvasEl = renderer.domElement;
	const lastPointer = new THREE.Vector2();
	let navigating = false;

	// Click or tap an insect and it bolts. A fingertip covers far more than a fly does, so
	// touch gets a wider catch than the mouse.
	const insectUnder = event => insects && insects.pick(
		event.clientX, event.clientY, camera, window.innerWidth, window.innerHeight,
		event.pointerType === 'touch' ? 34 : 16 );

	canvasEl.addEventListener( 'pointerdown', event => {

		if ( event.button !== 0 ) return;
		const insect = insectUnder( event );
		if ( insect ) insects.startle( insect, event.clientX, event.clientY, camera, window.innerWidth, window.innerHeight );

	} );

	// The hand over an insect says it can be clicked; the crosshair everywhere else.
	canvasEl.addEventListener( 'pointermove', event => {

		if ( event.pointerType !== 'mouse' || navigating ) return;
		canvasEl.style.cursor = insectUnder( event ) ? 'pointer' : '';

	} );

	// A middle-button press would otherwise start the browser's own autoscroll.
	canvasEl.addEventListener( 'mousedown', event => {

		if ( event.button === 1 ) event.preventDefault();

	} );

	canvasEl.addEventListener( 'pointerdown', event => {

		if ( event.button !== 1 ) return;

		event.preventDefault();

		// Not before the menu is unlocked, and not while the opening is flying the camera:
		// a drag would only fight it.
		if ( ! unlocked || intro.active ) return;

		navigating = true;
		lastPointer.set( event.clientX, event.clientY );
		try { canvasEl.setPointerCapture( event.pointerId ); } catch ( error ) { /* synthetic pointer */ }

	} );

	canvasEl.addEventListener( 'pointermove', event => {

		if ( ! navigating ) return;

		const dx = event.clientX - lastPointer.x;
		const dy = event.clientY - lastPointer.y;
		lastPointer.set( event.clientX, event.clientY );

		if ( event.shiftKey ) pan( dx, dy );
		else if ( event.ctrlKey ) dolly( - dy * 0.01 );
		else orbit( dx, dy );

	} );

	const endNavigation = event => {

		if ( ! navigating ) return;
		navigating = false;
		if ( canvasEl.hasPointerCapture( event.pointerId ) ) canvasEl.releasePointerCapture( event.pointerId );

	};

	canvasEl.addEventListener( 'pointerup', endNavigation );
	canvasEl.addEventListener( 'pointercancel', endNavigation );

	canvasEl.addEventListener( 'wheel', event => {

		event.preventDefault();

		if ( intro.active ) {

			intro.skip();
			return;

		}

		if ( ! unlocked ) return;

		const lines = event.deltaMode === 1 ? 16 : 1;
		dolly( - event.deltaY * lines * 0.0015 * ( event.shiftKey ? 3 : 1 ) );

	}, { passive: false } );

	document.querySelectorAll( '[data-action]' ).forEach( button => {

		button.addEventListener( 'click', () => {

			const action = button.dataset.action;
			if ( action === 'glb' ) exportGLB( terrainMesh );
			else if ( action === 'obj' ) exportOBJ( terrainMesh );
			else if ( action === 'reset' ) resetView();

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

	applyLens();

	// Mountain and cabin are both framed in screen space, so a reshape moves them — and the
	// opening title's spot in the sky with them.
	placeMountain();
	placeCabin();
	intro.invalidate();

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

/**
 * Sets the day / night clock running or stops it — from the menu's checkbox or a double
 * Space. Stopped, the light stays at whatever hour it had reached.
 */
function setDayNight( on ) {

	dayNight.running = on;
	tuned.dayNight = on;
	if ( panel ) panel.set( 'dayNight', on );

}

/**
 * The time of day: opened at the light over Damavand right now (see build), held there,
 * and looped fast when the clock is set running.
 */
const _moonRise = new THREE.Vector3();

function updateDayNight( dt ) {

	// The moon comes up behind the middle of the cabin, wherever the layout has put it.
	let moonRise = null;

	if ( cabin.wall ) {

		if ( ! cabin.wall.geometry.boundingBox ) cabin.wall.geometry.computeBoundingBox();
		cabin.wall.geometry.boundingBox.getCenter( _moonRise );
		moonRise = cabin.wall.localToWorld( _moonRise );

	}

	const view = heroView();
	view.moonRise = moonRise;
	dayNight.update( dt, view );

	uniforms.u_lampWall.value = cabin.lampWorld( uniforms.u_lampPosition.value, uniforms.u_lampNormal.value );
	cabin.setLampGlow( dayNight.lamp );

	// The day's insects fly off at dusk and come back after sunrise.
	insects.setPresent( dayNight.insectsOut );

	grade.tintOpacity = tuned.tintOpacity * dayNight.tintScale;
	grade.tintColor.copy( dayNight.tintColor );

	if ( dayNight.running && panel && panel.visible ) panel.set( 'dayHour', + dayNight.hour.toFixed( 2 ) );

}

/** The opening: flies the rig's anchor and the lens until it lands on the hero shot. */
function updateIntro( dt ) {

	if ( ! intro.active ) return;

	const pose = intro.update( dt, heroPose() );

	cameraRig.setAnchor( {
		position: pose.position,
		rotation: pose.rotation,
		cameraDistance: SHOT.camera.cameraDistance
	} );

	applyLens( pose.fov );

}

function frame( dt ) {

	uniforms.u_time.value += dt;

	updateIntro( dt );
	updateKeyboardFly( dt );
	cameraRig.update( dt );
	intro.placeTitle( camera );
	insects.update( dt, camera );
	updateDayNight( dt );

	// The sky sphere is only radius 15, so it rides with the camera rather than enclosing
	// the world.
	skyMesh.position.copy( camera.position );

	updateInteractionField();

	renderer.setRenderTarget( sceneTarget );
	renderer.clear( true, true, true );
	renderer.render( scene, camera );

	bloom.render( renderer, sceneTarget.texture, bloomTarget );
	grade.render( renderer, bloomTarget.texture, width, height, null );

	renderer.setRenderTarget( null );

}
