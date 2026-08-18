/**
 * Shared scatter helper.
 *
 * The original's grass_placement.buf cannot be reused on this hill: its 48 768 points
 * were distributed over the river terrain and carry a bald channel straight through
 * the middle of the stage (it shows up as an empty stripe around x = 0.8 … 1.8). On a
 * river-less hill that reads as a scar, so points are generated instead — while
 * keeping the original's blade scale range and terrain-relative conventions.
 */
import * as THREE from '../vendor/three.module.js';
import { fbm } from './HillGeometry.js';

/** Deterministic PRNG, so a reload gives back the identical meadow. */
export function makeRandom( seed = 1 ) {

	let state = seed >>> 0;

	return function random() {

		state = ( state + 0x6D2B79F5 ) >>> 0;
		let t = state;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

/**
 * Jittered-grid scatter across the stage, rejected against terrain slope, a noise
 * density mask and the fog rim.
 *
 * `rimRadius` is the distance past which the fog has fully dissolved the ground, so
 * there is no point paying for geometry beyond it.
 */
export function scatterOnSurface( surface, {
	count = 48000,
	seed = 1,
	rimRadius = 4.7,
	maxSlope = 0.62,
	slopeFalloff = 0.34,
	patchScale = 0.45,
	patchStrength = 0.55,
	upBlend = 0.35,
	jitter = 0.9
} = {} ) {

	const random = makeRandom( seed );

	// oversample the grid and reject — rejection is what creates the patchiness
	const cells = Math.ceil( Math.sqrt( count * 1.85 ) );
	const step = rimRadius * 2 / cells;

	const positions = [];
	const normals = [];
	const sample = { y: 0, nx: 0, ny: 1, nz: 0 };

	for ( let j = 0; j < cells; j ++ ) {

		for ( let i = 0; i < cells; i ++ ) {

			if ( positions.length >= count * 3 ) break;

			const x = - rimRadius + ( i + 0.5 + ( random() - 0.5 ) * jitter ) * step;
			const z = - rimRadius + ( j + 0.5 + ( random() - 0.5 ) * jitter ) * step;

			if ( Math.abs( x ) > rimRadius || Math.abs( z ) > rimRadius ) continue;

			if ( ! surface.sample( x, z, sample ) ) continue;

			const slope = 1 - sample.ny;

			// bare rock on the steep faces, with a soft transition
			let density = 1 - THREE.MathUtils.smoothstep( slope, maxSlope - slopeFalloff, maxSlope );

			// broad patches of thicker and thinner grass
			const patch = fbm( x * patchScale, z * patchScale, 3 ) * 0.5 + 0.5;
			density *= 1 - patchStrength + patchStrength * patch;

			// thin out toward the fog line
			const edge = Math.max( Math.abs( x ), Math.abs( z ) );
			density *= 1 - THREE.MathUtils.smoothstep( edge, rimRadius - 1.1, rimRadius );

			if ( random() > density ) continue;

			positions.push( x, sample.y, z );

			// grass stands more upright than the ground it grows on
			const nx = sample.nx * ( 1 - upBlend );
			const ny = sample.ny * ( 1 - upBlend ) + upBlend;
			const nz = sample.nz * ( 1 - upBlend );
			const length = Math.hypot( nx, ny, nz ) || 1;

			normals.push( nx / length, ny / length, nz / length );

		}

	}

	return {
		positions: new Float32Array( positions ),
		normals: new Float32Array( normals ),
		count: positions.length / 3
	};

}

const _up = new THREE.Vector3( 0, 1, 0 );
const _normal = new THREE.Vector3();
const _align = new THREE.Quaternion();
const _yaw = new THREE.Quaternion();

/**
 * Quaternion that stands a Y-up prop on a surface with the given normal, then spins it
 * by `yawAngle`. The blade geometry runs 0 → 1 along +Y, so this is the whole of the
 * orientation an instance needs.
 */
export function orientToNormal( nx, ny, nz, yawAngle, target = new THREE.Quaternion() ) {

	_normal.set( nx, ny, nz ).normalize();
	_align.setFromUnitVectors( _up, _normal );
	_yaw.setFromAxisAngle( _up, yawAngle );

	return target.copy( _align ).multiply( _yaw );

}
