/**
 * Procedural hill, authored to the same conventions as the original terrain so every
 * shader keeps working untouched:
 *
 *   • footprint is a 10 × 10 unit stage centred on the origin (the shaders derive
 *     their UV as `worldPosition.xz / 10.0 + 0.5`)
 *   • Y is up, and the height range is kept close to the original's ~1 unit span so
 *     the grass blade heights (0.08 – 0.30) stay in proportion
 *   • the rim is pushed down and flattened, because the fog SDF dissolves everything
 *     past a rounded box of half-size 2.5 / radius 1 — the readable "island" is
 *     roughly |x|,|z| < 4 and it must fade into sky, not end on a visible cliff
 *
 * No river: the original terrain carved a channel through the middle, and the whole
 * point here is an unbroken meadow.
 */
import * as THREE from '../vendor/three.module.js';

/**
 * Shaped to the reference: two rounded mounds with a saddle between them, seen from a
 * low camera looking down -Z. Measuring the grass/sky boundary in the reference gives a
 * left crest at ~30% of frame width, the saddle at ~53%, and a broader right crest
 * running off the right edge — so the two mounds are spread along X, with the right one
 * bigger, nearer and pushed off-centre.
 *
 * Each mound is `height * (1 - min(1, r))^falloff` where r is the elliptical distance
 * from its centre. That gives a broad crown and straight flanks; a gaussian would
 * produce a pointier, more artificial dome.
 */
export const HILL_DEFAULTS = {
	stageSize: 10,
	segments: 200,

	// Fitted to Reference/photo_*.jpg by tools/fit-hill.mjs, which traces the grass/sky
	// boundary the same way the reference was measured and hill-climbs the parameters
	// against it. Mean skyline error 0.011 of frame height.
	//
	// The mounds are wide and low rather than tall and narrow: at fov 30 the frame spans
	// only ~4.7 units at the crest distance, and the camera cannot back off to widen it
	// (past z ≈ 4 the fog SDF starts dissolving the foreground). Broad overlapping
	// falloffs are what produce a shallow saddle instead of a hard notch.
	mounds: [
		// left mound — nearer crest, left of frame centre
		{ x: - 1.39, z: - 1.38, height: 0.71, radiusX: 4.23, radiusZ: 2.9, falloff: 1.8 },
		// right mound — set back behind the left one so it reads as further away
		{ x: 1.64, z: - 2.87, height: 1.10, radiusX: 2.50, radiusZ: 3.2, falloff: 1.7 },
		// Broad low ridge spanning both. It ended up nearly as tall as the crests and much
		// wider than either — that is what flattens the silhouette to the reference's very
		// gentle profile. Combining with max() means it lifts the saddle floor without
		// touching the crests.
		{ x: 0.34, z: - 1.70, height: 0.53, radiusX: 4.74, radiusZ: 3.4, falloff: 1.5 }
	],

	// keeps the saddle from reading as a clean mathematical notch
	saddleNoise: 0.1,

	// large soft undulation + fine surface detail
	rollAmplitude: 0.14,
	rollScale: 0.42,
	detailAmplitude: 0.042,
	detailScale: 1.7,

	// how hard the stage edge is pulled down toward the fog
	rimStart: 3.4,
	rimEnd: 5.0,
	rimDrop: 0.5,

	baseY: - 0.42
};

/* ── value-noise fbm ───────────────────────────────────────────────────────── */

function hash2( x, y ) {

	let h = x * 374761393 + y * 668265263;
	h = ( h ^ ( h >> 13 ) ) * 1274126177;
	return ( ( h ^ ( h >> 16 ) ) >>> 0 ) / 4294967295;

}

function smootherstep( t ) {

	return t * t * t * ( t * ( t * 6 - 15 ) + 10 );

}

function valueNoise( x, y ) {

	const xi = Math.floor( x ), yi = Math.floor( y );
	const xf = smootherstep( x - xi ), yf = smootherstep( y - yi );

	const v00 = hash2( xi, yi );
	const v10 = hash2( xi + 1, yi );
	const v01 = hash2( xi, yi + 1 );
	const v11 = hash2( xi + 1, yi + 1 );

	const a = v00 + ( v10 - v00 ) * xf;
	const b = v01 + ( v11 - v01 ) * xf;

	return ( a + ( b - a ) * yf ) * 2 - 1;

}

export function fbm( x, y, octaves = 4 ) {

	let sum = 0, amplitude = 1, frequency = 1, norm = 0;

	for ( let i = 0; i < octaves; i ++ ) {

		sum += valueNoise( x * frequency, y * frequency ) * amplitude;
		norm += amplitude;
		amplitude *= 0.5;
		frequency *= 2.03;

	}

	return sum / norm;

}

/* ── height field ──────────────────────────────────────────────────────────── */

export function makeHeightFunction( options = {} ) {

	const o = Object.assign( {}, HILL_DEFAULTS, options );

	return function height( x, z ) {

		// The mounds are combined with max(), not a sum. Adding them would fill the
		// saddle in with the overlap of the two falloffs and flatten the notch that
		// makes the silhouette read as two hills rather than one lumpy ridge.
		let y = 0;

		for ( let i = 0; i < o.mounds.length; i ++ ) {

			const m = o.mounds[ i ];
			const dx = ( x - m.x ) / m.radiusX;
			const dz = ( z - m.z ) / m.radiusZ;
			const r = Math.sqrt( dx * dx + dz * dz );

			const contribution = m.height * Math.pow( Math.max( 0, 1 - Math.min( 1, r ) ), m.falloff );
			if ( contribution > y ) y = contribution;

		}

		// soften the seam where the two mounds meet
		y += fbm( x * 0.8 + 43.1, z * 0.8 + 17.9, 2 ) * o.saddleNoise;

		// organic undulation + fine surface detail
		y += fbm( x * o.rollScale, z * o.rollScale, 3 ) * o.rollAmplitude;
		y += fbm( x * o.detailScale + 11.3, z * o.detailScale - 7.1, 4 ) * o.detailAmplitude;

		// rim: ease the stage edge downward so it can dissolve into the fog
		const edge = Math.max( Math.abs( x ), Math.abs( z ) );
		const rim = THREE.MathUtils.smoothstep( edge, o.rimStart, o.rimEnd );
		y -= rim * rim * o.rimDrop;
		y *= 1 - rim * 0.35;

		return y + o.baseY;

	};

}

export function createHillGeometry( options = {} ) {

	const o = Object.assign( {}, HILL_DEFAULTS, options );
	const height = makeHeightFunction( o );

	const segments = o.segments;
	const size = o.stageSize;
	const vertexCount = ( segments + 1 ) * ( segments + 1 );

	const positions = new Float32Array( vertexCount * 3 );
	const normals = new Float32Array( vertexCount * 3 );
	const indices = new Uint32Array( segments * segments * 6 );

	for ( let j = 0; j <= segments; j ++ ) {

		const z = ( j / segments - 0.5 ) * size;

		for ( let i = 0; i <= segments; i ++ ) {

			const x = ( i / segments - 0.5 ) * size;
			const k = ( j * ( segments + 1 ) + i ) * 3;

			positions[ k ] = x;
			positions[ k + 1 ] = height( x, z );
			positions[ k + 2 ] = z;

		}

	}

	// central-difference normals straight off the height function — cheaper and
	// smoother than averaging face normals on a regular grid
	const step = size / segments;
	for ( let j = 0; j <= segments; j ++ ) {

		const z = ( j / segments - 0.5 ) * size;

		for ( let i = 0; i <= segments; i ++ ) {

			const x = ( i / segments - 0.5 ) * size;
			const k = ( j * ( segments + 1 ) + i ) * 3;

			const hL = height( x - step, z ), hR = height( x + step, z );
			const hD = height( x, z - step ), hU = height( x, z + step );

			let nx = hL - hR;
			let ny = 2 * step;
			let nz = hD - hU;

			const len = Math.hypot( nx, ny, nz ) || 1;
			normals[ k ] = nx / len;
			normals[ k + 1 ] = ny / len;
			normals[ k + 2 ] = nz / len;

		}

	}

	let t = 0;
	for ( let j = 0; j < segments; j ++ ) {

		for ( let i = 0; i < segments; i ++ ) {

			const a = j * ( segments + 1 ) + i;
			const b = a + 1;
			const c = a + segments + 1;
			const d = c + 1;

			indices[ t ++ ] = a; indices[ t ++ ] = c; indices[ t ++ ] = b;
			indices[ t ++ ] = b; indices[ t ++ ] = c; indices[ t ++ ] = d;

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();

	return geometry;

}
