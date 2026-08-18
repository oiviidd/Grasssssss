/**
 * Fits the hill parameters and camera to a reference skyline.
 *
 * The reference profile is the grass/sky boundary measured from
 * Reference/photo_*.jpg, sampled at 21 columns across the frame (0 = top of frame).
 *
 * Rather than solve analytically, this traces the same thing the image measurement did:
 * cast a fan of rays from the camera, walk each one along the ground, project every
 * sample, and keep the highest point that lands in each column. Then hill-climb over
 * the mound and camera parameters.
 *
 * Run: node tools/fit-hill.mjs
 */
import { readFileSync } from 'node:fs';
import * as THREE from '../vendor/three.module.js';
import { makeHeightFunction, HILL_DEFAULTS } from '../src/HillGeometry.js';

// Produced by tools/measure_reference.py. Regenerate it whenever the target image
// changes, then re-run this fitter.
const METRICS = JSON.parse( readFileSync( new URL( './reference-metrics.json', import.meta.url ) ) );
const REFERENCE = METRICS.skyline;

console.log( 'reference:', METRICS.source, METRICS.size.join( '×' ), 'aspect', METRICS.aspect );
if ( METRICS.excludeX.length ) console.log( 'excluded columns:', JSON.stringify( METRICS.excludeX ) );

const COLUMNS = REFERENCE.length;
const FOV = 30;
const ASPECT = 16 / 9;
const TAN_HALF_V = Math.tan( FOV / 2 * Math.PI / 180 );
const TAN_HALF_H = TAN_HALF_V * ASPECT;

/**
 * Skyline profile for a given height function + camera, as frame-y per column.
 *
 * This walks a fan of ground tracks in world space and projects every sample through a
 * real THREE.PerspectiveCamera — the same class the renderer uses — rather than
 * approximating the projection.
 *
 * An earlier version linearised the pitch as `viewY = worldY - camY + pitch * distance`.
 * That is fine near pitch 0 but the error grows with both pitch and distance, and at the
 * ~10° pitch this shot wants it reached `pitch × 8 = 1.4` units of pure error on the far
 * samples. The fit converged happily to 0.016 while the actual render measured 0.042,
 * because the two were not projecting the same scene.
 */
const _camera = new THREE.PerspectiveCamera( FOV, ASPECT, 0.05, 20 );
const _point = new THREE.Vector3();

function profile( height, cam, grassHeight = 0 ) {

	const columns = new Array( COLUMNS ).fill( 1 );

	_camera.position.set( cam.x, cam.y, cam.z );
	_camera.rotation.set( - cam.pitch, - cam.yaw, 0, 'XYZ' );
	_camera.updateMatrixWorld( true );
	_camera.updateProjectionMatrix();

	const cy = Math.cos( cam.yaw ), sy = Math.sin( cam.yaw );

	for ( let r = 0; r < 260; r ++ ) {

		const tx = ( r / 259 - 0.5 ) * 2 * TAN_HALF_H;

		for ( let d = 0.5; d < 11; d += 0.05 ) {

			// point on the view ray's ground track
			const lx = tx * d, lz = - d;
			const px = cam.x + lx * cy - lz * sy;
			const pz = cam.z + lx * sy + lz * cy;

			// The visible skyline is the top of the *grass*, not the ground. That offset is
			// constant in world space but not in frame space — it subtends a larger angle
			// the nearer it is — and the crest is both the highest and the furthest thing
			// on the skyline, so ignoring it systematically exaggerates the fitted
			// landform. Modelling bare terrain gave a rendered range of 0.198 against a
			// reference 0.102, even at a converged fit error of 0.015.
			_point.set( px, height( px, pz ) + grassHeight, pz ).project( _camera );

			if ( _point.x < - 1 || _point.x > 1 || _point.z > 1 ) continue;

			const col = Math.round( ( _point.x * 0.5 + 0.5 ) * ( COLUMNS - 1 ) );
			const frameY = 0.5 - _point.y * 0.5;

			if ( frameY < columns[ col ] ) columns[ col ] = frameY;

		}

	}

	return columns;

}

function score( columns ) {

	// Columns the measurement excluded (a foreground object rather than grass or sky)
	// come through as null and must not contribute — otherwise the fit drags sideways to
	// chase something that is not the landform.
	let sum = 0, counted = 0;

	for ( let i = 0; i < COLUMNS; i ++ ) {

		if ( REFERENCE[ i ] === null ) continue;
		sum += Math.abs( columns[ i ] - REFERENCE[ i ] );
		counted ++;

	}

	return counted ? sum / counted : Infinity;

}

/* ── parameter vector ──────────────────────────────────────────────────────── */

function build( v ) {

	const options = Object.assign( {}, HILL_DEFAULTS, {
		mounds: [
			{ x: v.lx, z: v.lz, height: v.lh, radiusX: v.lrx, radiusZ: 2.9, falloff: 1.8 },
			{ x: v.rx, z: v.rz, height: v.rh, radiusX: v.rrx, radiusZ: 3.2, falloff: 1.7 },
			// broad, low ridge spanning both: lifts the saddle without touching the crests
			{ x: v.gx, z: - 1.7, height: v.gh, radiusX: v.grx, radiusZ: 3.4, falloff: 1.5 }
		]
	} );

	return makeHeightFunction( options );

}

/**
 * Eye height is pinned rather than fitted, because matching a skyline alone is
 * degenerate — a low camera with low hills and a high camera with tall hills produce the
 * same silhouette. Left free, the fit chose an eye at 0.50, below the flowers (0.41–0.51
 * tall), which filled the foreground with them.
 *
 * Raised from 0.85 after measuring against the reference two ways:
 *   • blade edge frequency along horizontal scanlines — mine was already slightly finer
 *     than the reference, so blade *width* was never the problem
 *   • skyline raggedness (detrended std of the topmost grass pixel) — mine 0.021 of
 *     frame height against the reference's 0.058
 *
 * Foreground grass too large *and* distant grass too small is a depth-ratio symptom, not
 * a blade-size one: foreground angular size goes as blade/eyeHeight, distant as
 * blade/distance. Both are off in opposite directions only when distance/eyeHeight is
 * too small — the hills sat too close for how low the camera was. Raising the eye and
 * letting the fit pull the mounds nearer and lower fixes both at once, and keeps the
 * hills at the same angular size because the fit holds the skyline.
 */
const ARGS = Object.fromEntries( process.argv.slice( 2 ).map( a => a.replace( /^--/, '' ).split( '=' ) ) );

const EYE_CLEARANCE = ARGS.eye !== undefined ? Number( ARGS.eye ) : 1.7;

/** The right mound has to sit demonstrably further back than the left one. */
const MIN_RIGHT_SETBACK = ARGS.setback !== undefined ? Number( ARGS.setback ) : 1.1;

/**
 * Height of the grass canopy above the ground, in world units — what actually forms the
 * silhouette rather than the bare terrain.
 *
 * Measured, not fitted. Left as a free parameter it is degenerate with terrain height:
 * the hill can drop by whatever the canopy rises and the projected skyline is unchanged.
 * The fit duly drove it to 0.52 and lowered the mounds to match, which then rendered
 * 0.136 of frame height off because the real canopy is nowhere near that tall.
 *
 * Calibrated by projecting the bare terrain at a range of offsets and finding which one
 * reproduces the measured render: 0.11. Note this is much shorter than the tallest
 * tufts, because the skyline metric requires grass to persist 18 rows — it tracks where
 * the canopy is *dense*, not the wispy tips above it.
 *
 * Re-calibrate if blade or tuft scale changes materially.
 */
const CANOPY = ARGS.canopy !== undefined ? Number( ARGS.canopy ) : 0.11;

console.log( 'eye clearance', EYE_CLEARANCE, '· right setback', MIN_RIGHT_SETBACK, '· canopy', CANOPY );

let best = {
	lx: - 1.55, lz: - 1.35, lh: 0.92, lrx: 2.05,
	rx: 1.75, rz: - 2.60, rh: 1.10, rrx: 2.50,
	gx: 0.10, gh: 0.62, grx: 4.20,
	camX: - 0.55, camZ: 3.20, pitch: 0, yaw: 0
};

function cameraFor( v, height ) {

	return {
		x: v.camX,
		y: height( v.camX, v.camZ ) + EYE_CLEARANCE,
		z: v.camZ,
		pitch: v.pitch,
		yaw: v.yaw
	};

}

function evaluate( v ) {

	const height = build( v );
	return score( profile( height, cameraFor( v, height ), CANOPY ) );

}

let bestScore = evaluate( best );
console.log( 'start error', bestScore.toFixed( 4 ) );

const KNOBS = {
	lx: 0.12, lz: 0.15, lh: 0.06, lrx: 0.15,
	rx: 0.12, rz: 0.15, rh: 0.06, rrx: 0.15,
	gx: 0.15, gh: 0.05, grx: 0.2,
	camX: 0.12, camZ: 0.12, pitch: 0.015, yaw: 0.02
};

// plain coordinate hill-climb with shrinking steps — the surface is smooth and low
// dimensional, so this converges fine and stays reproducible
for ( let pass = 0; pass < 60; pass ++ ) {

	let improved = false;
	const shrink = Math.pow( 0.94, pass );

	for ( const key in KNOBS ) {

		for ( const dir of [ 1, - 1 ] ) {

			const candidate = Object.assign( {}, best );
			candidate[ key ] += KNOBS[ key ] * shrink * dir;

			// keep the camera inside the fog's clean core
			if ( Math.abs( candidate.camZ ) > 3.8 || Math.abs( candidate.camX ) > 2.2 ) continue;

			// hold the right mound behind the left one
			if ( candidate.rz > candidate.lz - MIN_RIGHT_SETBACK ) continue;

			const s = evaluate( candidate );
			if ( s < bestScore - 1e-6 ) { bestScore = s; best = candidate; improved = true; }

		}

	}

	if ( ! improved && shrink < 0.25 ) break;

}

console.log( 'final error', bestScore.toFixed( 4 ) );
console.log( '\nparams:' );
for ( const k in best ) console.log( '  ' + k.padEnd( 6 ), ( + best[ k ].toFixed( 3 ) ) );

const finalHeight = build( best );
const finalCamera = cameraFor( best, finalHeight );
console.log( '\ncamera y (ground ' + finalHeight( best.camX, best.camZ ).toFixed( 3 ) +
	' + ' + EYE_CLEARANCE + ') =', finalCamera.y.toFixed( 3 ) );
const finalProfile = profile( finalHeight, finalCamera, CANOPY );
console.log( '\ncol   ref    fit' );
for ( let i = 0; i < COLUMNS; i ++ ) {

	const ref = REFERENCE[ i ];
	console.log( '  ' + ( i / ( COLUMNS - 1 ) ).toFixed( 2 ) + '  ' +
		( ref === null ? ' skip' : ref.toFixed( 3 ) ) + '  ' + finalProfile[ i ].toFixed( 3 ) );

}
