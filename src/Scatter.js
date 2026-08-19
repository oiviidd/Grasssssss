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
	bounds = null,
	rimRadius = 4.7,
	rimFade = 1.1,
	maxSlope = 0.62,
	slopeFalloff = 0.34,
	patchScale = 0.45,
	patchStrength = 0.55,
	upBlend = 0.35,
	jitter = 0.9,
	seed = 1
} = {} ) {

	const random = makeRandom( seed );

	// Cover the terrain's actual footprint, not a square centred on the origin. A sculpted
	// hill is rarely centred, and assuming symmetry scatters into empty space on one side
	// while leaving a bald strip on the other — which reads as "one edge is fine, the rest
	// have a margin".
	const area = bounds || { minX: - rimRadius, maxX: rimRadius, minZ: - rimRadius, maxZ: rimRadius };

	const spanX = Math.max( 0.01, area.maxX - area.minX );
	const spanZ = Math.max( 0.01, area.maxZ - area.minZ );

	// `count` is a density, quoted against a reference 9.4 x 9.4 stage — not an absolute.
	// Tying the grid to count alone meant widening the extent spread the same blades over
	// more ground and thinned the whole meadow; this keeps density fixed and lets the
	// total follow the area.
	const REFERENCE_SPAN = 9.4;
	const perAxis = Math.sqrt( count * 1.85 ) / REFERENCE_SPAN;

	const cellsX = Math.max( 1, Math.ceil( spanX * perAxis ) );
	const cellsZ = Math.max( 1, Math.ceil( spanZ * perAxis ) );

	const stepX = spanX / cellsX;
	const stepZ = spanZ / cellsZ;

	const positions = [];
	const normals = [];
	const sample = { y: 0, nx: 0, ny: 1, nz: 0 };

	for ( let j = 0; j < cellsZ; j ++ ) {

		for ( let i = 0; i < cellsX; i ++ ) {

			const x = area.minX + ( i + 0.5 + ( random() - 0.5 ) * jitter ) * stepX;
			const z = area.minZ + ( j + 0.5 + ( random() - 0.5 ) * jitter ) * stepZ;

			if ( x < area.minX || x > area.maxX || z < area.minZ || z > area.maxZ ) continue;

			if ( ! surface.sample( x, z, sample ) ) continue;

			const slope = 1 - sample.ny;

			// bare rock on the steep faces, with a soft transition
			let density = 1 - THREE.MathUtils.smoothstep( slope, maxSlope - slopeFalloff, maxSlope );

			// broad patches of thicker and thinner grass
			const patch = fbm( x * patchScale, z * patchScale, 3 ) * 0.5 + 0.5;
			density *= 1 - patchStrength + patchStrength * patch;

			// Fade against the nearest edge of the actual footprint, so every side gets the
			// same treatment however the mesh is placed.
			const fade = Math.max( 0.01, rimFade );
			const inset = Math.min( x - area.minX, area.maxX - x, z - area.minZ, area.maxZ - z );
			density *= THREE.MathUtils.smoothstep( inset, 0, fade );

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
