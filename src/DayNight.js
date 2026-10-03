/**
 * ── DAY / NIGHT ────────────────────────────────────────────────────────────────
 * A test rig, not part of the shot: off by default, switched on from the tweak panel.
 * While it runs, the clock loops through sunrise, day, sunset and a moonlit night, with
 * the lantern over the cabin door lit through the dark.
 *
 * There is still no THREE.Light anywhere. Everything is the shared uniforms that the
 * <lusionFog> chunk reads (see glsl/fog.js), driven by the sun's height through a
 * handful of keyframes. With the cycle off they all go back to neutral, so the frame
 * is exactly the tuned daylight shot again.
 *
 * The sun and the moon move in the camera's own frame rather than on a real compass:
 * sunset is placed off the left of the shot and sunrise off the right, so the glow of
 * both reaches the visible sky, and the moon arcs low across the open sky over the
 * mountain, where the frame can actually see it.
 */

import * as THREE from '../vendor/three.module.js';

// Sun height (the sine of its elevation) → the look. Between keys it is smoothly blended.
//   sky       multiplies every sky lookup, fog and haze included
//   ambient   multiplies every surface
//   desat     moonlight: how far surfaces fall toward grey before they are tinted
//   glow      the sun's horizon glow, colour × strength
//   moon      moon disc and halo     stars  star field     lamp   the door lantern
//   tint      multiplier on the grade's tint strength      tintHex  the grade's tint colour
//   dawn      what the morning does differently: cooler and pinker where dusk is orange,
//             so sunrise does not play as sunset run backwards
const KEYS = [
	{ e: - 0.30, sky: [ 0.10, 0.14, 0.30 ], ambient: [ 0.25, 0.33, 0.54 ], desat: 0.6, glow: [ 0, 0, 0 ], moon: 1, stars: 1, lamp: 1, tint: 0.6, tintHex: 0x2f4f8f },
	{ e: - 0.12, sky: [ 0.26, 0.24, 0.46 ], ambient: [ 0.30, 0.30, 0.45 ], desat: 0.45, glow: [ 0.30, 0.10, 0.16 ], moon: 0.5, stars: 0.35, lamp: 1, tint: 0.7, tintHex: 0x4f5f9f,
		dawn: { sky: [ 0.30, 0.30, 0.50 ], glow: [ 0.30, 0.16, 0.22 ] } },
	{ e: 0.00, sky: [ 0.80, 0.56, 0.60 ], ambient: [ 0.78, 0.58, 0.48 ], desat: 0.12, glow: [ 0.95, 0.40, 0.14 ], moon: 0, stars: 0, lamp: 0.55, tint: 0.65, tintHex: 0xc99a72,
		dawn: { sky: [ 0.74, 0.66, 0.80 ], ambient: [ 0.80, 0.68, 0.66 ], glow: [ 0.95, 0.55, 0.45 ], tintHex: 0xc9a3a8 } },
	{ e: 0.12, sky: [ 1.00, 0.86, 0.72 ], ambient: [ 1.00, 0.88, 0.74 ], desat: 0, glow: [ 0.55, 0.28, 0.10 ], moon: 0, stars: 0, lamp: 0, tint: 0.85, tintHex: 0x9ab0b8,
		dawn: { sky: [ 0.96, 0.90, 0.86 ], ambient: [ 1.00, 0.92, 0.86 ], glow: [ 0.50, 0.32, 0.26 ] } },
	{ e: 0.35, sky: [ 1, 1, 1 ], ambient: [ 1, 1, 1 ], desat: 0, glow: [ 0, 0, 0 ], moon: 0, stars: 0, lamp: 0, tint: 1, tintHex: null }
];

// Warm, slightly orange — a candle behind amber glass, not a bulb.
const LAMP_COLOR = [ 1.0, 0.62, 0.28 ];
const LAMP_STRENGTH = 2.2;

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3( 0, 1, 0 );
const _colorA = new THREE.Color();
const _colorB = new THREE.Color();

export class DayNight {

	constructor( uniforms, { tintHex } ) {

		this.uniforms = uniforms;

		this.enabled = false;
		this.hour = 16;
		this.speed = 0.5; // in-game hours per real second; 24 is one whole day a second

		// Read by main.js each frame and handed to the grade.
		this.tintScale = 1;
		this.tintColor = new THREE.Color( tintHex );
		this.baseTint = new THREE.Color( tintHex );

		// How lit the lantern is, 0..1, for its glow sprite.
		this.lamp = 0;

		this._flicker = 0;

	}

	/** The sun's height: −1 at midnight, 0 at 6:00 and 18:00, 1 at noon. */
	get elevation() {

		return Math.sin( ( this.hour - 6 ) / 24 * Math.PI * 2 );

	}

	update( dt, viewQuaternion ) {

		if ( this.enabled ) {

			this.hour = ( ( this.hour + dt * this.speed ) % 24 + 24 ) % 24;
			this._apply( viewQuaternion, dt );

		} else {

			this._neutral();

		}

	}

	_neutral() {

		const u = this.uniforms;

		u.u_skyTint.value.set( 1, 1, 1 );
		u.u_ambient.value.set( 1, 1, 1 );
		u.u_desaturate.value = 0;
		u.u_sunGlow.value.set( 0, 0, 0 );
		u.u_moonGlow.value.set( 0, 0, 0 );
		u.u_moon.value = 0;
		u.u_stars.value = 0;
		u.u_lampColor.value.set( 0, 0, 0 );

		this.lamp = 0;
		this.tintScale = 1;
		this.tintColor.copy( this.baseTint );

	}

	_apply( viewQuaternion, dt ) {

		const u = this.uniforms;
		const e = this.elevation;

		// Which pair of keys, and how far between them.
		let i = 0;
		while ( i < KEYS.length - 2 && e > KEYS[ i + 1 ].e ) i ++;
		const a = KEYS[ i ];
		const b = KEYS[ i + 1 ];
		let t = THREE.MathUtils.clamp( ( e - a.e ) / ( b.e - a.e ), 0, 1 );
		t = t * t * ( 3 - 2 * t );

		const morning = this.hour < 12;
		const pick = ( key, field ) => morning && key.dawn && key.dawn[ field ] !== undefined ? key.dawn[ field ] : key[ field ];

		const mix = ( x, y ) => x + ( y - x ) * t;
		const mix3 = ( target, field ) => {

			const x = pick( a, field );
			const y = pick( b, field );
			return target.set( mix( x[ 0 ], y[ 0 ] ), mix( x[ 1 ], y[ 1 ] ), mix( x[ 2 ], y[ 2 ] ) );

		};

		mix3( u.u_skyTint.value, 'sky' );
		mix3( u.u_ambient.value, 'ambient' );
		mix3( u.u_sunGlow.value, 'glow' );
		u.u_desaturate.value = mix( a.desat, b.desat );

		const moon = mix( a.moon, b.moon );
		u.u_moon.value = moon;
		u.u_stars.value = mix( a.stars, b.stars );
		u.u_moonGlow.value.set( 0.55, 0.62, 0.8 ).multiplyScalar( moon );

		// A slow, uneven flicker — two detuned sines, so it never settles into a visible beat.
		this._flicker += dt;
		const flicker = 1 + 0.035 * Math.sin( this._flicker * 7.3 ) + 0.025 * Math.sin( this._flicker * 13.1 + 1.7 );
		this.lamp = mix( a.lamp, b.lamp ) * flicker;
		u.u_lampColor.value.set( LAMP_COLOR[ 0 ], LAMP_COLOR[ 1 ], LAMP_COLOR[ 2 ] ).multiplyScalar( LAMP_STRENGTH * this.lamp );

		this.tintScale = mix( a.tint, b.tint );
		_colorA.set( pick( a, 'tintHex' ) === null ? this.baseTint : pick( a, 'tintHex' ) );
		_colorB.set( pick( b, 'tintHex' ) === null ? this.baseTint : pick( b, 'tintHex' ) );
		this.tintColor.copy( _colorA ).lerp( _colorB, t );

		/* sun and moon --------------------------------------------------------- */

		_forward.set( 0, 0, - 1 ).applyQuaternion( viewQuaternion );
		_forward.y = 0;
		if ( _forward.lengthSq() < 1e-6 ) _forward.set( 0, 0, - 1 );
		_forward.normalize();
		_right.crossVectors( _forward, _up ).normalize();

		// Up from the right at 6:00, overhead and a little behind at noon, down on the left
		// at 18:00 — about 30° either side of the view at the horizon.
		const day = ( this.hour - 6 ) / 12 * Math.PI;
		const high = Math.max( Math.sin( day ), 0 );
		u.u_sunDir.value.set( 0, 0, 0 )
			.addScaledVector( _right, Math.cos( day ) * 0.55 )
			.addScaledVector( _up, Math.sin( day ) * 0.9 )
			.addScaledVector( _forward, 0.85 - 1.1 * high )
			.normalize();

		// The moon rises as the sun sets and keeps low, crossing the sky above the mountain.
		const night = ( ( this.hour - 18 + 24 ) % 24 ) / 12 * Math.PI;
		u.u_moonDir.value.set( 0, 0, 0 )
			.addScaledVector( _right, Math.cos( night ) * 0.3 - 0.2 )
			.addScaledVector( _up, Math.sin( night ) * 0.2 + 0.02 )
			.addScaledVector( _forward, 1 )
			.normalize();

	}

}
