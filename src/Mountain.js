/**
 * The distant snow-capped cone.
 *
 * Three separable pieces, so each can be replaced independently:
 *
 *   createMountainGeometry()  — a stratovolcano cone. Concave flanks (steep at the
 *                               summit, flaring at the base), a small crater notch,
 *                               and a few radial ridges so the silhouette is not a
 *                               perfect circle. Cylindrically unwrapped.
 *   bakeMountainMap()         — the albedo: rock, gullies, and a snow cap whose line
 *                               is ragged and drips down the gullies.
 *   Mountain                  — placement. Its horizontal position is solved from a
 *                               *screen* anchor rather than stored in world space,
 *                               so the cone holds its place in the frame as the
 *                               viewport changes shape.
 *
 * Both the geometry and the map can be swapped for an artist's own via the panel.
 */
import * as THREE from '../vendor/three.module.js';
import { fbm } from './HillGeometry.js';
import { mountainVert, mountainFrag } from './glsl/mountain.js';
import { dayNightUniforms } from './glsl/fog.js';

/**
 * `profile` is the exponent on the radius falloff: 1 is a straight cone, higher is
 * more concave — the flanks steepen toward the summit and flare out at the base,
 * which is what reads as a stratovolcano rather than a party hat.
 */
export function createMountainGeometry( {
	radius = 4.2,
	height = 3.4,
	profile = 1.2,
	summitRadius = 0.12,
	ridgeAmount = 0.16,
	ridgeCount = 7,
	roughness = 0.045,
	radialSegments = 84,
	heightSegments = 28,
	seed = 3
} = {} ) {

	const positions = [];
	const uvs = [];
	const indices = [];

	// A few incommensurate lobes: enough to break the circle, not enough to read as noise.
	const lobe = angle =>
		Math.cos( angle * ridgeCount + 0.7 ) * 0.55 +
		Math.cos( angle * ( ridgeCount + 3 ) - 2.1 ) * 0.3 +
		Math.cos( angle * ( ridgeCount * 2 + 1 ) + 4.4 ) * 0.15;

	for ( let j = 0; j <= heightSegments; j ++ ) {

		const v = j / heightSegments;

		// summitRadius keeps the crater from collapsing to a needle point
		let r = summitRadius + ( radius - summitRadius ) * Math.pow( 1 - v, profile );

		for ( let i = 0; i <= radialSegments; i ++ ) {

			const u = i / radialSegments;
			const angle = u * Math.PI * 2;

			// Ridges fade out toward the summit, where a real cone is nearly circular.
			const taper = Math.pow( 1 - v, 0.7 );
			const wobble = 1 +
				ridgeAmount * lobe( angle ) * taper +
				roughness * fbm( Math.cos( angle ) * 2.4 + seed, Math.sin( angle ) * 2.4 + v * 3.1, 3 );

			const rr = r * wobble;

			positions.push( Math.cos( angle ) * rr, v * height, Math.sin( angle ) * rr );
			uvs.push( u, v );

		}

	}

	const stride = radialSegments + 1;

	for ( let j = 0; j < heightSegments; j ++ ) {

		for ( let i = 0; i < radialSegments; i ++ ) {

			const a = j * stride + i;
			const b = a + stride;

			indices.push( a, b, a + 1 );
			indices.push( a + 1, b, b + 1 );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
	geometry.setIndex( indices );
	geometry.computeVertexNormals();

	return geometry;

}

/**
 * Albedo for the cone, in its cylindrical unwrap: u is the angle, v runs base → summit.
 *
 * Values are deliberately dark. Nothing in this project is lit in the usual sense — the
 * beauty pass is near-black by design and the grade is what turns it into daylight — so a
 * map painted at "correct" screen brightness comes out blown after grading.
 */
export function bakeMountainMap( {
	// Named apart from the cone's own width/height on purpose. Both option sets are handed
	// the same bag by Mountain.build(), and a plain `height` here silently took the cone's
	// 3.4 *world units* as a pixel count — a 1024x3 map, which is why the snow line
	// vanished into three flat bands.
	mapWidth = 1024,
	mapHeight = 512,
	// Where the unbroken cap ends. Below it the snow does not simply stop — it runs down the
	// gullies as tongues, which is the reference's most recognisable feature.
	snowLine = 0.72,
	snowSoftness = 0.03,
	// How far below the cap the longest tongues reach, and how many there are around the cone.
	tongueLength = 0.42,
	tongueCount = 15,
	tongueSharpness = 0.07,
	// 0 is the cool grey-blue the reference *photograph* measures (hue ~202, sat 0.28); 1 is
	// warm brown rock. A single dial rather than raw colours, because the panel has no colour
	// picker and the two ends are the only choices that ever came up.
	rockWarmth = 1,
	// Multipliers on the two snow tones and on the spread between lit and shadowed rock.
	// Snow brightness sets how white the cap goes; snow shade is how dark its gullies get,
	// so the two together are the contrast *within* the snow, which is what stops the cap
	// reading as a flat paper cut-out.
	snowBrightness = 1,
	snowShade = 1,
	rockContrast = 1
} = {} ) {

	const SNOW_LIT = [ 0.920, 0.950, 1.000 ];
	const SNOW_DARK = [ 0.440, 0.520, 0.680 ];

	const snowColor = SNOW_LIT.map( c => Math.min( 1, c * snowBrightness ) );
	const snowShadeColor = SNOW_DARK.map( c => Math.min( 1, c * snowBrightness * snowShade ) );

	const COOL_ROCK = [ 0.135, 0.160, 0.200 ];
	const COOL_DARK = [ 0.055, 0.070, 0.098 ];

	// Dark brown, and only mildly pre-compensated for the grade's cyan tint. The rusty orange
	// this used to carry came from trying to make the *final pixel* saturated brown; the
	// reference does the opposite — dark brown rock read through a lot of atmosphere, which is
	// why the photo measures blue-grey. The mist belongs in the shader, not the albedo.
	const WARM_ROCK = [ 0.840, 0.395, 0.150 ];
	const WARM_DARK = [ 0.330, 0.145, 0.052 ];

	const w = Math.min( 1, Math.max( 0, rockWarmth ) );
	const litRock = COOL_ROCK.map( ( c, i ) => c + ( WARM_ROCK[ i ] - c ) * w );
	const darkRock = COOL_DARK.map( ( c, i ) => c + ( WARM_DARK[ i ] - c ) * w );

	// Contrast pivots around the lit tone, so turning it up deepens the gullies rather than
	// darkening the whole cone.
	const rockColor = litRock;
	const rockDark = litRock.map( ( c, i ) => c + ( darkRock[ i ] - c ) * rockContrast );

	const data = new Uint8Array( mapWidth * mapHeight * 4 );
	const mix = ( a, b, t ) => a + ( b - a ) * t;
	const smooth = ( e0, e1, x ) => {
		const t = Math.min( 1, Math.max( 0, ( x - e0 ) / ( e1 - e0 ) ) );
		return t * t * ( 3 - 2 * t );
	};
	const contrast = ( x, k ) => Math.min( 1, Math.max( 0, ( x - 0.5 ) * k + 0.5 ) );

	for ( let j = 0; j < mapHeight; j ++ ) {

		const v = ( j + 0.5 ) / mapHeight;

		for ( let i = 0; i < mapWidth; i ++ ) {

			const u = ( i + 0.5 ) / mapWidth;
			const angle = u * Math.PI * 2;

			// Sampling the noise on the circle rather than on u keeps the map seamless where
			// the unwrap wraps around — a straight fbm(u) leaves a visible vertical scar.
			const cx = Math.cos( angle );
			const cz = Math.sin( angle );

			/* ── gullies ───────────────────────────────────────────────────────── */
			// High frequency around the cone, low frequency up it: vertical streaks.
			const gully = fbm( cx * 9, cz * 9 + v * 1.6, 4 ) * 0.5 + 0.5;
			const grain = fbm( cx * 26, cz * 26 + v * 5.0, 3 ) * 0.5 + 0.5;

			/* ── snow ──────────────────────────────────────────────────────────── */
			// An unbroken cap, plus tongues running down the gullies below it.
			//
			// The tongues are what the old wandering-line-with-drips could not produce. Each
			// angle gets a depth it can hold snow to; `reach` grows from 0 at the cap to 1 at
			// the deepest tongue, so as the map descends only the angles with the strongest
			// noise keep any, and the tongues taper to points instead of ending as a band.
			// The cap's edge wanders with angle. Without this it is a ruled horizontal line
			// across the cone, which is the one thing that instantly reads as computer-generated.
			const line = snowLine + fbm( cx * 2.6, cz * 2.6, 2 ) * 0.06;
			const cap = smooth( line - snowSoftness, line + snowSoftness, v );

			// Two octaves, not four. The tongue shape wants to be *smooth* and its edge crisp;
			// piling octaves into the value being thresholded does the opposite — it turns the
			// boundary into a sawtooth, because every high-frequency wiggle crosses the
			// threshold again. Detail belongs in the shading below, not in this mask.
			const tongueNoise = contrast(
				fbm( cx * tongueCount + v * 0.7, cz * tongueCount - v * 0.5, 2 ) * 0.5 + 0.5, 1.2 );

			const reach = ( line - v ) / Math.max( 1e-4, tongueLength );
			const tongue = v < line
				? smooth( reach - tongueSharpness, reach + tongueSharpness, tongueNoise )
				: 0;

			const snow = Math.max( cap, tongue );

			/* ── compose ───────────────────────────────────────────────────────── */
			// Gullies darken the rock; the same mask shades the snow, so the drips read as
			// depth rather than as paint sitting on top.
			//
			// fbm clusters around its midpoint, so a raw sum never reaches either end and
			// both rock and snow come out as the same flat mid-tone. The stretch is what
			// puts actual light and shade on the cone.
			const rockT = contrast( gully * 0.75 + grain * 0.25, 1.9 );
			const snowT = contrast( gully * 0.6 + grain * 0.4, 2.2 );

			const o = ( j * mapWidth + i ) * 4;

			for ( let c = 0; c < 3; c ++ ) {

				const rock = mix( rockDark[ c ], rockColor[ c ], rockT );
				const cap = mix( snowShadeColor[ c ], snowColor[ c ], snowT );

				data[ o + c ] = Math.round( Math.min( 1, mix( rock, cap, snow ) ) * 255 );

			}

			data[ o + 3 ] = 255;

		}

	}

	const texture = new THREE.DataTexture( data, mapWidth, mapHeight, THREE.RGBAFormat );
	texture.wrapS = THREE.RepeatWrapping;
	texture.minFilter = THREE.LinearFilter;
	texture.magFilter = THREE.LinearFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;

	return texture;

}

export class Mountain {

	constructor( uniforms ) {

		this.container = new THREE.Object3D();
		this.uniforms = uniforms;
		this.mesh = null;
		this.map = null;
		// An artist's imported geometry/map outlives a rebuild; a generated one does not.
		this.ownsMap = false;
		this.ownsGeometry = false;

	}

	build( options = {} ) {

		this.dispose();

		this.ownsGeometry = ! options.geometry;
		const geometry = options.geometry || createMountainGeometry( options );
		geometry.computeBoundingBox();

		if ( options.map ) {

			this.map = options.map;
			this.ownsMap = false;

		} else {

			this.map = bakeMountainMap( options );
			this.ownsMap = true;

		}

		this.mesh = new THREE.Mesh( geometry, new THREE.ShaderMaterial( {
			uniforms: {
				u_map: { value: this.map },
				u_exposure: { value: options.exposure !== undefined ? options.exposure : 1 },
				u_haze: { value: options.haze !== undefined ? options.haze : 0.42 },
				u_lightWrap: { value: options.lightWrap !== undefined ? options.lightWrap : 0.45 },
				u_lightTint: { value: options.lightTint !== undefined ? options.lightTint : 0.45 },
				u_unlit: { value: options.unlit !== undefined ? options.unlit : 0 },
				u_modelHeightRange: { value: new THREE.Vector2( geometry.boundingBox.min.y, geometry.boundingBox.max.y ) },
				u_baseMist: { value: options.baseMist !== undefined ? options.baseMist : 0.55 },
				u_baseMistHeight: { value: options.baseMistHeight !== undefined ? options.baseMistHeight : 0.45 },
				u_envTexture: this.uniforms.u_envTexture,
				...dayNightUniforms( this.uniforms )
			},
			vertexShader: mountainVert,
			fragmentShader: mountainFrag
		} ) );

		// It sits beyond everything else and never needs to occlude anything, so it is drawn
		// before the meadow — the grass then overdraws its base for free.
		this.mesh.renderOrder = - 900;
		this.mesh.frustumCulled = false;

		this.container.add( this.mesh );

		return this;

	}

	dispose() {

		if ( ! this.mesh ) return;

		this.container.remove( this.mesh );
		if ( this.ownsGeometry ) this.mesh.geometry.dispose();
		this.mesh.material.dispose();
		if ( this.ownsMap && this.map ) this.map.dispose();

		this.mesh = null;
		this.map = null;

	}

	/**
	 * The cone's own height in model units, before scaling.
	 *
	 * Read off the mesh rather than off the config, so it stays right when an artist imports
	 * a cone of their own and the shape sliders no longer describe it.
	 */
	modelHeight() {

		if ( ! this.mesh ) return 0;

		const geometry = this.mesh.geometry;
		if ( ! geometry.boundingBox ) geometry.computeBoundingBox();

		return Math.max( 1e-6, geometry.boundingBox.max.y - geometry.boundingBox.min.y );

	}

	/**
	 * Height of the model's highest point above its own origin, before scaling.
	 *
	 * Placement pins the *summit*, so this — not the overall height — is what it needs. The two
	 * only agree when the mesh stands exactly on its origin: the generated cone does, an
	 * imported one rarely does (mount.glb's base sits at y = -0.18).
	 */
	modelTop() {

		if ( ! this.mesh ) return 0;

		const geometry = this.mesh.geometry;
		if ( ! geometry.boundingBox ) geometry.computeBoundingBox();

		return Math.max( 1e-6, geometry.boundingBox.max.y );

	}

	/** Live handles for the panel, so a slider does not have to rebuild the mesh. */
	set( key, value ) {

		if ( ! this.mesh ) return;
		const uniform = this.mesh.material.uniforms[ key ];
		if ( uniform ) uniform.value = value;

	}

	/**
	 * Puts the cone at a horizontal position in the *frame* rather than in the world.
	 *
	 * `anchorX` is NDC: -1 is the left edge, +1 the right. A phone in portrait sees a far
	 * narrower slice of the world than a desktop does (the fov is vertical, so a narrow
	 * viewport crops the sides), and a mountain pinned to a world x simply leaves the shot.
	 * Solving from the anchor each resize keeps the composition instead.
	 *
	 * Depth and elevation stay in world units — those are what make it read as distant, and
	 * they must not drift with the viewport.
	 *
	 * `view` is the *base* framing, not the live camera: the rig adds shake and mouse-look
	 * every frame, and re-solving against those would glue the mountain to the camera and
	 * kill the parallax that is the entire reason it is geometry and not a painted sky.
	 */
	place( view, { anchorX = 0, distance = 12, baseY = - 1.6, width = 1, height = 1 } = {} ) {

		if ( ! this.mesh ) return;

		const halfV = THREE.MathUtils.degToRad( view.fov ) * 0.5;
		const forward = _forward.set( 0, 0, - 1 ).applyQuaternion( view.quaternion );
		const right = _right.set( 1, 0, 0 ).applyQuaternion( view.quaternion );

		// Flattened to the ground plane: the cone stands upright in the world however the
		// camera is tilted, so only its horizontal placement follows the frame.
		forward.y = 0;
		right.y = 0;
		if ( forward.lengthSq() < 1e-6 ) forward.set( 0, 0, - 1 );
		forward.normalize();
		right.normalize();

		const offset = distance * Math.tan( halfV ) * view.aspect * anchorX;

		this.container.position.set(
			view.position.x + forward.x * distance + right.x * offset,
			baseY,
			view.position.z + forward.z * distance + right.z * offset
		);

		// Non-uniform on purpose — see MOUNTAIN.wide/narrow in shot.js.
		this.container.scale.set( width, height, width );

	}

}

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
