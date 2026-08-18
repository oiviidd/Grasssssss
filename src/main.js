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
import { SHOT, INSECTS, GRASS } from './shot.js';
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
const RIM_RADIUS = 4.7;

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
	u_terrainInfoTexture: { value: null },
	u_terrainGrassTexture: { value: null },
	u_terrainRocksTexture: { value: null },
	u_terrainAOTexture: { value: null },
	u_terrainDrawTexture: { value: null }
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
		u_drag: { value: 0.975 }
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

	// Bake the maps the original shipped as painted textures. They have to be generated
	// rather than reused: grass.jpg has the river channel stained into it, and the AO /
	// rock masks follow the old riverbed.
	const raster = surface.rasterize( MAP_RESOLUTION, STAGE_SIZE );
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
				u_envTexture: uniforms.u_envTexture
			},
			vertexShader: skyVert,
			fragmentShader: skyFrag,
			side: THREE.BackSide
		} )
	);
	skyMesh.frustumCulled = false;
	scene.add( skyMesh );

	/* ground ------------------------------------------------------------------ */

	terrainMesh = new THREE.Mesh( hillGeometry, new THREE.ShaderMaterial( {
		uniforms: {
			u_envTexture: uniforms.u_envTexture,
			u_terrainInfoTexture: uniforms.u_terrainInfoTexture,
			u_terrainGrassTexture: uniforms.u_terrainGrassTexture,
			u_terrainRocksTexture: uniforms.u_terrainRocksTexture,
			u_terrainAOTexture: uniforms.u_terrainAOTexture
		},
		vertexShader: terrainVert,
		fragmentShader: terrainFrag
	} ) );
	terrainMesh.material.extensions.derivatives = true;
	terrainMesh.renderOrder = - 1000;
	scene.add( terrainMesh );

	/* grass, flowers, insects ------------------------------------------------- */

	grass.build( surface, {
		rimRadius: RIM_RADIUS,
		bladeCount: GRASS.bladeCount,
		bladeWidthScale: GRASS.bladeWidthScale,
		bladeHeightScale: GRASS.bladeHeightScale,
		tuftInstances: GRASS.tuftInstances,
		tuftScale: GRASS.tuftScale
	} );
	scene.add( grass.container );

	flowers.build( surface, assets.flowers, {
		rimRadius: RIM_RADIUS,
		flowerCount: GRASS.flowerCount,
		flowerScale: GRASS.flowerScale
	} );
	scene.add( flowers.container );

	insects.build( surface, INSECTS );
	scene.add( insects.container );

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
		renderer, scene, camera, cameraRig, bloom, grade, uniforms, surface,
		grass, flowers, get insects() { return insects; },
		hill: HILL_DEFAULTS,
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
				rimRadius: RIM_RADIUS,
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
				Math.round( ( x / STAGE_SIZE + 0.5 ) * 256 ),
				Math.round( ( z / STAGE_SIZE + 0.5 ) * 256 ),
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
	atlasCells: 5
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
				rimRadius: RIM_RADIUS,
				flowerCount: tuned.flowerCount,
				flowerScale: tuned.flowerScale,
				atlasCells: tuned.atlasCells
			} );

		} else {

			grass.dispose();
			grass.build( surface, {
				rimRadius: RIM_RADIUS,
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

	if ( camera.fov !== tuned.fov ) {

		camera.fov = tuned.fov;
		camera.updateProjectionMatrix();

	}

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

export const GRASS = {
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
		.note( 'Requirements for imported files', [
			'<b>Hill</b> &mdash; <code>.glb</code>. Y up, Z forward (Blender glTF default). Keep it inside a <code>10 &times; 10</code> unit box centred on the origin: the shaders derive UV as <code>worldPosition.xz / 10.0 + 0.5</code>, so anything outside samples clamped edge pixels. Keep height within roughly <code>&plusmn;1</code> unit &mdash; blades are only 0.08&ndash;0.30 tall and that ratio is what sells the scale. Let the rim fall away past <code>|x|</code> or <code>|z| &asymp; 3.5</code>; fog dissolves the ground out there and a hard edge reads as a cut. Apply modifiers, export normals.',
			'<b>Blade</b> &mdash; <code>.glb</code>, one small mesh. Model a <i>single</i> blade standing on the origin and pointing +Y. Size and position do not matter: it is re-based to 0&ndash;1 in Y on import, because the shader uses <code>position.y</code> directly as the bend ratio. Keep it very low poly &mdash; this is drawn 150k+ times; the original is 7 vertices. Flat cards work best. Two-sided is automatic.',
			'<b>Tuft</b> &mdash; <code>.glb</code>. <b>One</b> clump of tall grass, standing on the origin pointing +Y, re-based the same way. Export gives you a single clump for exactly this reason: whatever you send back is treated as one tuft and scattered, so do not model a whole field. A few hundred vertices is fine; it is drawn a few thousand times, and total tuft vertices are capped, so a heavy clump lowers the count that fits. Silhouette matters more than detail &mdash; this is what breaks the skyline.',
			'<b>Flower sheet</b> &mdash; <code>.png</code> with alpha. A single horizontal strip of flowers, evenly divided, each cell drawn on a quad standing on its base. Export gives you the current sheet (750&times;256, 5 cells) to paint over. Set <i>atlas cells</i> to however many are in your strip. Each cell is about 3:5, taller than wide. Transparent background &mdash; anything under 0.4% alpha is discarded.',
			'Exports carry position and normals only. Internal attributes are stripped, because three writes anything it does not recognise as an integer custom accessor and Blender refuses the file when it meets one.',
			'Imports are live and temporary &mdash; nothing is written to the project. To keep one, hand the file to the developer; the hill also loads automatically from <code>assets/models/terrain_custom.glb</code>.'
		] )
		.actions();

	// start frozen, matching the toggle's default
	cameraRig.shakeStrength = 0;
	cameraRig.lookStrength = 0;

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
async function importTerrain( panel ) {

	const geometry = await readGLB( panel, 'Hill' );
	if ( ! geometry ) return;

	geometry.computeBoundingBox();
	const size = geometry.boundingBox.getSize( new THREE.Vector3() );

	surface = new TerrainSurface( geometry );
	const maps = bakeTerrainMaps( surface.rasterize( MAP_RESOLUTION, STAGE_SIZE ) );

	uniforms.u_terrainGrassTexture.value = maps.grassTexture;
	uniforms.u_terrainInfoTexture.value = maps.infoTexture;
	uniforms.u_terrainAOTexture.value = maps.aoTexture;

	terrainMesh.geometry.dispose();
	terrainMesh.geometry = geometry;

	usingCustomTerrain = true;
	rebuildEverything();

	// A mesh far outside the stage still renders, but its UVs clamp and it drifts out of
	// the fog's readable core — worth saying rather than leaving them to wonder.
	const oversized = size.x > 12 || size.z > 12;
	panel.say( oversized
		? `Loaded, but it is ${size.x.toFixed( 1 )}×${size.z.toFixed( 1 )} units — over 10×10, so UVs clamp.`
		: `Hill loaded (${size.x.toFixed( 1 )}×${size.z.toFixed( 1 )} units).` );

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
		rimRadius: RIM_RADIUS,
		bladeCount: tuned.bladeCount,
		bladeWidthScale: tuned.bladeWidthScale,
		bladeHeightScale: tuned.bladeHeightScale,
		tuftInstances: tuned.tuftInstances,
		tuftScale: tuned.tuftScale
	} );

	flowers.dispose();
	flowers.build( surface, flowerTexture, {
		rimRadius: RIM_RADIUS,
		flowerCount: tuned.flowerCount,
		flowerScale: tuned.flowerScale,
		atlasCells: tuned.atlasCells
	} );

	insects.container.clear();
	insects.insects.length = 0;
	insects.build( surface, INSECTS );

	updateStatus();

}

function applyShot() {

	const g = SHOT.grade;

	cameraRig.setAnchor( SHOT.camera );
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

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

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
