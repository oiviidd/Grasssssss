/**
 * Camera behaviour, ported from the original site.
 *
 * Three layers stack on top of the authored anchor transform:
 *   1. mouse look — eased pitch/yaw offsets applied *around a pivot* that sits
 *      `cameraDistance` units in front of the camera, so the framing swings rather
 *      than pans. This is what makes the parallax feel like a physical rig.
 *   2. free look — orbit/zoom offsets, now always zero. Navigation (orbit, pan, zoom, fly)
 *      lives in main.js and edits the anchor itself: an offset that reset on every
 *      setAnchor() was why a shot framed by dragging could never be saved.
 *   3. shake — fractal value noise on position (amplitude 0.12) and rotation
 *      (amplitude 0.003), both at frequency 0.3. Small, but it is the difference
 *      between "3D render" and "handheld".
 */
import * as THREE from '../vendor/three.module.js';

/** 256-sample value noise with smoothstep interpolation. */
function createValueNoise() {

	const table = [];
	for ( let i = 0; i < 256; i ++ ) table.push( Math.random() - 0.5 );

	return function ( x ) {

		const floored = Math.floor( x );
		const f = x - floored;
		const t = f * f * ( 3 - 2 * f );
		const a = table[ floored & 255 ];
		const b = table[ ( floored + 1 ) & 255 ];
		return a * ( 1 - t ) + b * t;

	};

}

const NORMALISE = 1 / 0.75; // fractal sum of 0.5 + 0.25 + 0.125 … never reaches 1

class SimplexNoiseObject {

	constructor() {

		this.position = new THREE.Vector3();
		this.rotation = new THREE.Quaternion();

		this.positionFrequency = 0.25;
		this.rotationFrequency = 0.25;
		this.positionAmplitude = 0.3;
		this.rotationAmplitude = 0.003;
		this.positionScale = new THREE.Vector3( 1, 1, 1 );
		this.rotationScale = new THREE.Vector3( 1, 1, 0 );
		this.positionFractalLevel = 3;
		this.rotationFractalLevel = 3;

		this.times = new Float32Array( 6 );
		for ( let i = 0; i < 6; i ++ ) this.times[ i ] = - 10000 * Math.random();

		this._noise = createValueNoise();
		this._euler = new THREE.Euler();
		this._v = new THREE.Vector3();

	}

	_fractal( x, levels ) {

		let sum = 0;
		let amplitude = 0.5;

		for ( let i = 0; i < levels; i ++ ) {

			sum += amplitude * this._noise( x );
			x *= 2;
			amplitude *= 0.5;

		}

		return sum;

	}

	update( dt ) {

		const v = this._v;

		for ( let i = 0; i < 3; i ++ ) this.times[ i ] += this.positionFrequency * dt;

		v.set(
			this._fractal( this.times[ 0 ], this.positionFractalLevel ),
			this._fractal( this.times[ 1 ], this.positionFractalLevel ),
			this._fractal( this.times[ 2 ], this.positionFractalLevel )
		);
		v.multiply( this.positionScale ).multiplyScalar( this.positionAmplitude * NORMALISE );
		this.position.copy( v );

		for ( let i = 0; i < 3; i ++ ) this.times[ i + 3 ] += this.rotationFrequency * dt;

		v.set(
			this._fractal( this.times[ 3 ], this.rotationFractalLevel ),
			this._fractal( this.times[ 4 ], this.rotationFractalLevel ),
			this._fractal( this.times[ 5 ], this.rotationFractalLevel )
		);
		v.multiply( this.rotationScale ).multiplyScalar( this.rotationAmplitude * NORMALISE );
		this._euler.set( v.x, v.y, v.z );
		this.rotation.setFromEuler( this._euler );

	}

}

export class CameraRig {

	constructor( camera, domElement ) {

		this.camera = camera;
		this.domElement = domElement;

		this.basePosition = new THREE.Vector3();
		this.baseQuaternion = new THREE.Quaternion();
		this.cameraDistance = 5;

		this.lookStrength = 0.032;
		this.lookEaseDamp = 0.075;
		this.shakeStrength = 0.3;
		this.shakePositionStrength = 0.12;
		this.shakePositionSpeed = 0.3;
		this.shakeRotationStrength = 0.003;
		this.shakeRotationSpeed = 0.3;

		this.lookX = 0;
		this.lookY = 0;
		this.mouseXY = new THREE.Vector2();

		// free-look, added on top of the authored anchor
		this.orbitYaw = 0;
		this.orbitPitch = 0;
		this.zoom = 0;

		this._shake = new SimplexNoiseObject();
		this._dragging = false;
		this._prev = new THREE.Vector2();

		this._q = new THREE.Quaternion();
		this._q2 = new THREE.Quaternion();
		this._e = new THREE.Euler();
		this._pivot = new THREE.Vector3();
		this._forward = new THREE.Vector3();

		this._bind();

	}

	_bind() {

		// Only the pointer position is tracked here, for the eased mouse look.
		this.domElement.addEventListener( 'pointermove', e => {

			this.mouseXY.set(
				( e.clientX / window.innerWidth ) * 2 - 1,
				- ( e.clientY / window.innerHeight ) * 2 + 1
			);

		} );

	}

	setAnchor( anchor ) {

		this.basePosition.fromArray( anchor.position );
		// Yaw about the world's up, then pitch about the camera's own x. 'XYZ' pitched about the
		// *world* x axis, which rolls the horizon as soon as the camera is turned — invisible
		// while yaw was 0, unavoidable once orbiting swings it round.
		this._e.set( anchor.rotation[ 0 ], anchor.rotation[ 1 ], anchor.rotation[ 2 ], 'YXZ' );
		this.baseQuaternion.setFromEuler( this._e );
		this.cameraDistance = anchor.cameraDistance;

		this.orbitYaw = 0;
		this.orbitPitch = 0;
		this.zoom = 0;

	}

	update( dt ) {

		const camera = this.camera;

		this.lookX += ( this.mouseXY.y * this.lookStrength - this.lookX ) * this.lookEaseDamp;
		this.lookY += ( - this.mouseXY.x * this.lookStrength - this.lookY ) * this.lookEaseDamp;

		// anchor + free-look orientation
		this._e.set( this.orbitPitch, this.orbitYaw, 0, 'XYZ' );
		this._q.setFromEuler( this._e );
		camera.quaternion.copy( this.baseQuaternion ).multiply( this._q );
		camera.position.copy( this.basePosition );

		// swing about a pivot cameraDistance in front, then apply the eased mouse look
		const distance = this.cameraDistance;
		this._forward.set( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
		this._pivot.copy( camera.position ).addScaledVector( this._forward, distance );

		this._e.set( this.lookX, this.lookY, 0, 'XYZ' );
		this._q2.setFromEuler( this._e );
		camera.quaternion.multiply( this._q2 );

		this._forward.set( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
		camera.position.copy( this._pivot ).addScaledVector( this._forward, - ( distance + this.zoom ) );

		// handheld shake
		const shake = this._shake;
		shake.positionAmplitude = this.shakePositionStrength * this.shakeStrength;
		shake.positionFrequency = this.shakePositionSpeed;
		shake.rotationAmplitude = this.shakeRotationStrength * this.shakeStrength;
		shake.rotationFrequency = this.shakeRotationSpeed;
		shake.update( dt );

		camera.position.add( shake.position );
		camera.quaternion.multiply( shake.rotation );

		camera.updateMatrixWorld();

	}

}
