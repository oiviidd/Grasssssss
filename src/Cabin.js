/**
 * The red cabin — the thing the visitor actually clicks.
 *
 * Built as three pieces rather than one, because each has a different job:
 *
 *   wall  — a box, so its corner shows. The reference frames a *corner* of the
 *           building, and that turn is what gives the home page its only real
 *           sense of depth against a backdrop of grass and sky.
 *   eave  — a slightly oversized slab on top. The dark overhang reads as a roof
 *           without modelling one; the reference never shows more than its edge.
 *   door  — its own mesh, sitting a hair proud of the wall. Separate because step
 *           5 raycasts it, and because it carries its own painted map: frame,
 *           panels, grain, the sun ornament and the handle.
 *
 * Colours are measured off Reference/kazmos.jpg, then pushed warmer and brighter
 * than the measurement: the beauty pass is near-black by design and the grade —
 * a cyan tint at 0.203 over the whole frame — cools everything on the way out.
 * The numbers in MOUNTAIN's comments explain that pipeline in more detail.
 */
import * as THREE from '../vendor/three.module.js';
import { fbm } from './HillGeometry.js';
import { cabinVert, cabinFrag, lampGlowVert, lampGlowFrag } from './glsl/cabin.js';
import { dayNightUniforms } from './glsl/fog.js';

/* ── helpers ───────────────────────────────────────────────────────────────── */

const mix = ( a, b, t ) => a + ( b - a ) * t;

const smooth = ( e0, e1, x ) => {
	const t = Math.min( 1, Math.max( 0, ( x - e0 ) / ( e1 - e0 ) ) );
	return t * t * ( 3 - 2 * t );
};

/** Box-in-a-band test with soft edges, for the door's frame and panel insets. */
const band = ( x, lo, hi, soft ) =>
	smooth( lo - soft, lo + soft, x ) * smooth( hi + soft, hi - soft, x );

function texture( data, width, height ) {

	const map = new THREE.DataTexture( data, width, height, THREE.RGBAFormat );
	map.minFilter = THREE.LinearFilter;
	map.magFilter = THREE.LinearFilter;
	map.generateMipmaps = false;
	map.needsUpdate = true;
	return map;

}

/* ── wall ──────────────────────────────────────────────────────────────────── */

/**
 * Painted plaster, not planks.
 *
 * The reference's wall is a flat matte red broken up by soft blotching and a few
 * long vertical weather streaks — no board joints anywhere. Reading it as siding
 * and drawing plank lines was the first thing that looked wrong.
 */
export function bakeCabinWallMap( {
	mapWidth = 512,
	mapHeight = 512,
	// The reference wall is [118,41,48] — hue 354, saturation 0.65. Getting there needs an
	// albedo with almost no green or blue at all.
	//
	// The grade screens a cyan tint over every pixel: #72b4c9 at 0.203 opacity adds roughly
	// (0.09, 0.14, 0.16). Inverting that screen for the reference colour asks for
	// (0.41, 0.02, 0.03) *after* lighting — and the sky, being the only light, is itself blue,
	// so it lifts green and blue again on the way in. A "reasonable-looking" red here comes
	// out dusty pink; these values are the pre-compensation, not the paint colour.
	wallColor = [ 0.900, 0.055, 0.070 ],
	weathering = 0.35,
	blotchScale = 3.2,
	streakStrength = 0.18
} = {} ) {

	const data = new Uint8Array( mapWidth * mapHeight * 4 );

	for ( let j = 0; j < mapHeight; j ++ ) {

		const v = ( j + 0.5 ) / mapHeight;

		for ( let i = 0; i < mapWidth; i ++ ) {

			const u = ( i + 0.5 ) / mapWidth;

			// Broad patches of faded and fresher paint.
			const blotch = fbm( u * blotchScale, v * blotchScale, 4 ) * 0.5 + 0.5;

			// Long vertical runs: high frequency across, very low down, so they read as
			// rain tracks rather than as noise.
			const streak = fbm( u * 26, v * 1.4, 3 ) * 0.5 + 0.5;

			// Grime gathers toward the bottom of a wall.
			const foot = 1 - smooth( 0.0, 0.42, v );

			let shade = 1 - weathering * ( 1 - blotch ) - streakStrength * ( 1 - streak );
			shade -= foot * 0.22;

			const o = ( j * mapWidth + i ) * 4;

			for ( let c = 0; c < 3; c ++ ) {

				data[ o + c ] = Math.round(
					Math.min( 1, Math.max( 0, wallColor[ c ] * shade ) ) * 255 );

			}

			data[ o + 3 ] = 255;

		}

	}

	return texture( data, mapWidth, mapHeight );

}

/* ── door ──────────────────────────────────────────────────────────────────── */

/**
 * The door, painted whole: architrave, stiles and rails, two recessed panels,
 * vertical grain, the sun ornament and the handle.
 *
 * u runs left→right across the door, v bottom→top.
 */
export function bakeCabinDoorMap( {
	mapWidth = 512,
	mapHeight = 1024,
	// measured [44, 50, 57] — charcoal with a cool cast, not black. Same tint correction as
	// the wall, so the green and blue sit well under where the eye expects them.
	doorColor = [ 0.215, 0.130, 0.130 ],
	frameColor = [ 0.150, 0.088, 0.090 ],
	// measured [125, 85, 54], hue 26
	ornamentColor = [ 0.980, 0.400, 0.075 ],
	handleColor = [ 0.680, 0.520, 0.330 ],
	ornamentSize = 0.20,
	ornamentRays = 8,
	ornamentSwirl = 0.55,
	grain = 0.22
} = {} ) {

	const data = new Uint8Array( mapWidth * mapHeight * 4 );

	// The architrave around the leaf, then the leaf itself inside it.
	const FRAME = 0.075;
	const LEAF_LO = FRAME, LEAF_HI = 1 - FRAME;

	for ( let j = 0; j < mapHeight; j ++ ) {

		const v = ( j + 0.5 ) / mapHeight;

		for ( let i = 0; i < mapWidth; i ++ ) {

			const u = ( i + 0.5 ) / mapWidth;

			const inLeaf = band( u, LEAF_LO, LEAF_HI, 0.006 ) * band( v, 0.02, 0.985, 0.004 );

			// Two recessed panels: a tall one above, a shorter one below.
			const upper = band( u, 0.20, 0.80, 0.010 ) * band( v, 0.50, 0.90, 0.006 );
			const lower = band( u, 0.20, 0.80, 0.010 ) * band( v, 0.08, 0.44, 0.006 );
			const panel = Math.max( upper, lower );

			// Vertical grain, plus a little dirt at the foot where the grass meets it.
			const wood = fbm( u * 90, v * 3.4, 3 ) * 0.5 + 0.5;
			const foot = 1 - smooth( 0.0, 0.14, v );

			let shade = 1 - grain * ( 1 - wood ) - foot * 0.3;

			// A panel sits back from the leaf, so it catches less light; the leaf sits back
			// from the architrave the same way.
			shade *= mix( 1, 0.86, panel );

			let colour = frameColor.map( ( c, k ) => mix( c, doorColor[ k ], inLeaf ) );
			colour = colour.map( c => c * shade );

			/* ── the sun ───────────────────────────────────────────────────────── */
			// Centred on the upper panel. The rays are swept, not straight: skewing the
			// angle by the radius is what turns a plain star into the reference's pinwheel.
			const ox = ( u - 0.5 ) / ornamentSize;
			const oy = ( v - 0.70 ) / ( ornamentSize * mapWidth / mapHeight );
			const rad = Math.hypot( ox, oy );

			if ( rad < 2 ) {

				const swept = Math.atan2( oy, ox ) + ornamentSwirl * rad;
				const petal = 1 + 0.42 * Math.cos( ornamentRays * swept );

				// A ring of petals with a hole in the middle, and a dark pupil in the hole.
				const ring = smooth( petal + 0.05, petal - 0.05, rad ) * smooth( 0.22, 0.32, rad );
				const pupil = smooth( 0.17, 0.11, rad );

				// Petal tips catch the light; the throat stays dark.
				const lit = mix( 0.62, 1, smooth( 0.35, 1.0, rad ) );
				const sun = Math.max( 0, ring - pupil );

				colour = colour.map( ( c, k ) => mix( c, ornamentColor[ k ] * lit, sun ) );

			}

			/* ── the handle ────────────────────────────────────────────────────── */
			// Lever plus backplate, on the closing edge at hand height.
			const plate = band( u, 0.735, 0.795, 0.004 ) * band( v, 0.435, 0.500, 0.004 );
			const lever = band( u, 0.640, 0.760, 0.004 ) * band( v, 0.462, 0.478, 0.003 );
			const metal = Math.max( plate, lever );

			colour = colour.map( ( c, k ) => mix( c, handleColor[ k ], metal ) );

			const o = ( j * mapWidth + i ) * 4;

			for ( let c = 0; c < 3; c ++ ) {

				data[ o + c ] = Math.round( Math.min( 1, Math.max( 0, colour[ c ] ) ) * 255 );

			}

			data[ o + 3 ] = 255;

		}

	}

	return texture( data, mapWidth, mapHeight );

}

/* ── lamp ──────────────────────────────────────────────────────────────────── */

/** The little brass lantern above the door. Alpha-cut, so it can hang on the wall. */
export function bakeCabinLampMap( {
	mapWidth = 128,
	mapHeight = 192,
	brass = [ 0.620, 0.470, 0.235 ],
	glass = [ 0.850, 0.720, 0.430 ]
} = {} ) {

	const data = new Uint8Array( mapWidth * mapHeight * 4 );

	for ( let j = 0; j < mapHeight; j ++ ) {

		const v = ( j + 0.5 ) / mapHeight;

		for ( let i = 0; i < mapWidth; i ++ ) {

			const u = ( i + 0.5 ) / mapWidth;

			// bracket arm out of the wall, then the lantern hanging off it
			const arm = band( u, 0.06, 0.52, 0.02 ) * band( v, 0.84, 0.92, 0.02 );
			const hood = band( u, 0.30, 0.86, 0.02 ) * band( v, 0.70, 0.84, 0.02 );
			const body = band( u, 0.36, 0.80, 0.02 ) * band( v, 0.24, 0.72, 0.02 );
			const foot = band( u, 0.34, 0.82, 0.02 ) * band( v, 0.18, 0.26, 0.02 );

			const pane = band( u, 0.42, 0.74, 0.015 ) * band( v, 0.30, 0.66, 0.015 );

			const solid = Math.max( Math.max( arm, hood ), Math.max( body, foot ) );
			const colour = brass.map( ( c, k ) => mix( c, glass[ k ], pane * 0.85 ) );

			const o = ( j * mapWidth + i ) * 4;

			for ( let c = 0; c < 3; c ++ ) {

				data[ o + c ] = Math.round( Math.min( 1, colour[ c ] ) * 255 );

			}

			data[ o + 3 ] = Math.round( solid * 255 );

		}

	}

	return texture( data, mapWidth, mapHeight );

}

/* ── the cabin ─────────────────────────────────────────────────────────────── */

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _lampGlass = new THREE.Vector3();

export class Cabin {

	constructor( uniforms ) {

		this.container = new THREE.Object3D();
		this.uniforms = uniforms;

		this.wall = null;
		this.eave = null;
		this.door = null;
		this.lamp = null;
		this.maps = [];
		// Imported geometry outlives a rebuild; generated geometry does not.
		this.owned = new Set();

		// Where the door lantern hangs, in the container's space, and how far in front of
		// its wall. The time of day lights the scene from here at night (see DayNight.js).
		this.lampAnchor = new THREE.Object3D();
		this.lampWall = 0.12;
		this.container.add( this.lampAnchor );

		this.lampGlow = new THREE.Mesh(
			new THREE.PlaneBufferGeometry( 1, 1 ),
			new THREE.ShaderMaterial( {
				uniforms: {
					u_color: { value: new THREE.Vector3( 1.0, 0.62, 0.28 ) },
					u_glow: { value: 0 },
					u_size: { value: 1.1 },
					u_pull: { value: 0.35 }
				},
				vertexShader: lampGlowVert,
				fragmentShader: lampGlowFrag,
				transparent: true,
				blending: THREE.AdditiveBlending,
				depthWrite: false
			} )
		);
		this.lampGlow.frustumCulled = false;
		this.lampGlow.renderOrder = 10;
		this.lampGlow.visible = false;
		this.lampAnchor.add( this.lampGlow );

	}

	/** Lantern glow, 0 (off, by day) to 1 (full night). */
	setLampGlow( level ) {

		this.lampGlow.material.uniforms.u_glow.value = level;
		this.lampGlow.visible = level > 0.001;

	}

	/**
	 * The lantern in world space, for the light it throws: its position, the direction out
	 * of the wall it hangs on, and the returned distance it hangs in front of that wall.
	 */
	lampWorld( position, normal ) {

		this.container.updateMatrixWorld();
		this.lampAnchor.getWorldPosition( position );
		normal.set( 0, 0, 1 ).transformDirection( this.container.matrixWorld );

		return this.lampWall * this.container.scale.x;

	}

	dispose() {

		[ this.wall, this.eave, this.door, this.lamp ].forEach( mesh => {

			if ( ! mesh ) return;
			this.container.remove( mesh );
			if ( this.owned.has( mesh.geometry ) ) mesh.geometry.dispose();
			mesh.material.dispose();

		} );

		this.maps.forEach( map => map.dispose() );
		this.maps = [];
		this.owned.clear();

		this.wall = this.eave = this.door = this.lamp = null;

	}

	_material( map, options, extra = {} ) {

		return new THREE.ShaderMaterial( Object.assign( {
			uniforms: {
				u_map: { value: map },
				u_exposure: { value: options.exposure !== undefined ? options.exposure : 1.6 },
				u_lightWrap: { value: options.lightWrap !== undefined ? options.lightWrap : 0.35 },
				u_lightTint: { value: options.lightTint !== undefined ? options.lightTint : 0.3 },
				u_unlit: { value: options.unlit !== undefined ? options.unlit : 0 },
				u_faceTint: { value: options.faceTint !== undefined ? options.faceTint : 0.32 },
				u_alphaTest: { value: extra.alphaTest !== undefined ? extra.alphaTest : - 1 },
				u_lodBias: { value: - 0.5 },
				u_envTexture: this.uniforms.u_envTexture,
				u_fogBox: this.uniforms.u_fogBox,
				u_fogCentre: this.uniforms.u_fogCentre,
				u_fogRadius: this.uniforms.u_fogRadius,
				u_fogStart: this.uniforms.u_fogStart,
				u_fogRange: this.uniforms.u_fogRange,
				u_hazeStart: this.uniforms.u_hazeStart,
				u_hazeRange: this.uniforms.u_hazeRange,
				u_hazeAmount: this.uniforms.u_hazeAmount,
				...dayNightUniforms( this.uniforms )
			},
			vertexShader: cabinVert,
			fragmentShader: cabinFrag
		}, extra.material || {} ) );

	}

	build( options = {} ) {

		this.dispose();

		const width = options.width !== undefined ? options.width : 2.6;
		const height = options.height !== undefined ? options.height : 3.2;
		const depth = options.depth !== undefined ? options.depth : 2.4;

		const doorWidth = options.doorWidth !== undefined ? options.doorWidth : 0.78;
		const doorHeight = options.doorHeight !== undefined ? options.doorHeight : 1.85;

		/* walls ---------------------------------------------------------------- */

		const wallMap = options.wallMap || bakeCabinWallMap( options );
		if ( ! options.wallMap ) this.maps.push( wallMap );

		// An imported wall keeps its own dimensions and its own origin — it was modelled to
		// sit on the ground, so it is not re-centred the way the generated box is.
		const importedWall = options.wallGeometry || null;
		const wallGeometry = importedWall || new THREE.BoxBufferGeometry( width, height, depth );
		if ( ! importedWall ) this.owned.add( wallGeometry );

		this.wall = new THREE.Mesh( wallGeometry, this._material( wallMap, options ) );

		this.wall.position.y = importedWall ? 0 : height * 0.5;
		this.container.add( this.wall );

		/* the eave ------------------------------------------------------------- */

		const overhang = options.eaveOverhang !== undefined ? options.eaveOverhang : 0.16;
		const eaveDepth = options.eaveHeight !== undefined ? options.eaveHeight : 0.17;

		const eaveMap = bakeCabinWallMap( Object.assign( {}, options, {
			mapWidth: 32,
			mapHeight: 32,
			// measured [43, 74, 88] — dark slate, the only cool thing on the building
			wallColor: options.eaveColor || [ 0.150, 0.245, 0.295 ],
			weathering: 0.15,
			streakStrength: 0.05
		} ) );
		this.maps.push( eaveMap );

		const eaveGeometry = new THREE.BoxBufferGeometry(
			width + overhang * 2, eaveDepth, depth + overhang * 2 );
		this.owned.add( eaveGeometry );

		this.eave = new THREE.Mesh( eaveGeometry, this._material( eaveMap, options ) );

		this.eave.position.y = height + eaveDepth * 0.5;
		this.container.add( this.eave );

		/* the door ------------------------------------------------------------- */

		const doorMap = options.doorMap || bakeCabinDoorMap( options );
		if ( ! options.doorMap ) this.maps.push( doorMap );

		const importedDoor = options.doorGeometry || null;
		const doorGeometry = importedDoor || new THREE.PlaneBufferGeometry( doorWidth, doorHeight );
		if ( ! importedDoor ) this.owned.add( doorGeometry );

		this.door = new THREE.Mesh( doorGeometry, this._material( doorMap, options ) );

		// A hair proud of the wall: coplanar would z-fight, and the reference's architrave
		// stands out from the plaster anyway.
		this.door.position.set(
			options.doorOffsetX !== undefined ? options.doorOffsetX : 0,
			doorHeight * 0.5,
			depth * 0.5 + 0.012 );

		// Named so the raycast in step 5 can find it without walking the scene graph.
		this.door.name = 'cabin-door';
		this.container.add( this.door );

		/* the lamp ------------------------------------------------------------- */

		if ( options.lamp !== false ) {

			const lampMap = bakeCabinLampMap( options );
			this.maps.push( lampMap );

			const lampHeight = options.lampSize !== undefined ? options.lampSize : 0.46;

			const lampGeometry = new THREE.PlaneBufferGeometry( lampHeight * 128 / 192, lampHeight );
			this.owned.add( lampGeometry );

			this.lamp = new THREE.Mesh( lampGeometry,
				this._material( lampMap, options, {
					alphaTest: 0.5,
					material: { transparent: false, side: THREE.DoubleSide }
				} ) );

			this.lamp.position.set(
				( options.doorOffsetX || 0 ) - doorWidth * 0.42,
				doorHeight + lampHeight * 0.55,
				depth * 0.5 + 0.02 );

			this.container.add( this.lamp );

		}

		// The light source: the artist's lantern when the model has one (its spot measured on
		// the model and kept in shot.js), otherwise the generated lamp's glass.
		if ( importedWall && options.lampPosition ) {

			this.lampAnchor.position.fromArray( options.lampPosition );
			this.lampWall = options.lampWall !== undefined ? options.lampWall : 0.12;

		} else if ( this.lamp ) {

			this.lampAnchor.position.copy( this.lamp.position ).add( _lampGlass.set( 0, - 0.04, 0.06 ) );
			this.lampWall = 0.08;

		} else {

			this.lampAnchor.position.set( options.doorOffsetX || 0, doorHeight + 0.25, depth * 0.5 + 0.1 );
			this.lampWall = 0.1;

		}

		// An imported cabin brings its own roof, lamp and door, so the generated ones are left
		// out rather than laid over it. The generated door survives only as an invisible hit
		// target for the click in step 5 — unless the artist supplied a door mesh of their own.
		if ( importedWall ) {

			if ( this.eave ) this.eave.visible = false;
			if ( this.lamp ) this.lamp.visible = false;
			if ( this.door && ! importedDoor ) this.door.visible = false;

		}

		return this;

	}

	/** Live uniform pokes for the panel, across every piece at once. */
	set( key, value ) {

		[ this.wall, this.eave, this.door, this.lamp ].forEach( mesh => {

			if ( ! mesh ) return;
			const uniform = mesh.material.uniforms[ key ];
			if ( uniform ) uniform.value = value;

		} );

	}

	/**
	 * Same screen-space anchoring as the mountain, and for the same reason: on a phone the
	 * fov crops the sides away, and a cabin pinned to a world x takes the door — the only
	 * thing on this page anyone is meant to click — out of the frame with it.
	 *
	 * Unlike the mountain it is seated on the terrain, so `surface` decides its y.
	 */
	place( view, surface, {
		anchorX = 0.62, distance = 2.4, yaw = - 0.32, sink = 0.06, scale = 1
	} = {} ) {

		const halfV = THREE.MathUtils.degToRad( view.fov ) * 0.5;

		const forward = _forward.set( 0, 0, - 1 ).applyQuaternion( view.quaternion );
		const right = _right.set( 1, 0, 0 ).applyQuaternion( view.quaternion );

		forward.y = 0;
		right.y = 0;
		if ( forward.lengthSq() < 1e-6 ) forward.set( 0, 0, - 1 );
		forward.normalize();
		right.normalize();

		const offset = distance * Math.tan( halfV ) * view.aspect * anchorX;

		const x = view.position.x + forward.x * distance + right.x * offset;
		const z = view.position.z + forward.z * distance + right.z * offset;

		// Sat *into* the ground a little, so the meadow grows up over the sill exactly as it
		// does in the reference instead of the wall ending on a visible seam.
		const sample = { y: 0, nx: 0, ny: 1, nz: 0 };
		const ground = surface && surface.sample( x, z, sample ) ? sample.y : 0;

		this.container.position.set( x, ground - sink, z );
		this.container.rotation.y = yaw;
		this.container.scale.setScalar( scale );

	}

}
