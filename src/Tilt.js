/**
 * ── TILT ───────────────────────────────────────────────────────────────────────
 * A phone's gyroscope as the mouse look, done the way the original site does it: the
 * phone's whole orientation as a quaternion (three's DeviceOrientationControls maths, so no
 * angle the phone is held at locks it up), followed by two eased copies — a quick one and,
 * behind it, a slow one. The turn from the slow to the quick one is the look: a tilt shows at
 * once and then, held, eases back to the middle, so the phone can be held any way at all.
 *
 *   quaternion  that turn, for the meadow's camera (CameraRig.setTilt)
 *   x, y        the same turn as −1..1 right / up, for the room's parallax (Interior.setTilt)
 *
 * Android reports orientation without asking, so listening starts at once. iOS asks the
 * user, and only from the end of a tap — call request() from a pointerup or click.
 */
import * as THREE from '../vendor/three.module.js';

// How quickly the quick copy follows the phone and the slow one follows it, per second.
// The original eases 0.02 a frame at 60 fps for both.
const FOLLOW = 1.2;
const SETTLE = 1.2;
// the turn, in radians, that reaches the edge of the room's parallax
const RANGE = 0.12;

const _zee = new THREE.Vector3( 0, 0, 1 );
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
// the camera looks out of the back of the device, not its top
const _q1 = new THREE.Quaternion( - Math.sqrt( 0.5 ), 0, 0, Math.sqrt( 0.5 ) );
const _inverse = new THREE.Quaternion();

export class Tilt {

	constructor() {

		this.x = 0;
		this.y = 0;
		this.quaternion = new THREE.Quaternion();
		this.active = false;

		this._device = new THREE.Quaternion();
		this._quick = new THREE.Quaternion();
		this._slow = new THREE.Quaternion();
		this._reading = null;
		this._started = false;
		this._listening = false;
		this._asking = false;
		this._onOrientation = event => { if ( event.beta !== null && event.gamma !== null ) this._reading = event; };

		if ( ! this.supported ) return;
		// where no permission is needed, straight away; otherwise try, in case it already was given
		if ( typeof window.DeviceOrientationEvent.requestPermission !== 'function' ) this._listen();
		else this.request();

	}

	get supported() {

		return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;

	}

	/** Asks for the gyroscope where the browser needs that. Call from the end of a tap. */
	request() {

		if ( ! this.supported || this._listening || this._asking ) return;

		const Orientation = window.DeviceOrientationEvent;
		if ( typeof Orientation.requestPermission !== 'function' ) {

			this._listen();
			return;

		}

		this._asking = true;
		Orientation.requestPermission()
			.then( state => { if ( state === 'granted' ) this._listen(); } )
			.catch( () => {} )
			.then( () => { this._asking = false; } );

	}

	_listen() {

		if ( this._listening ) return;
		this._listening = true;
		window.addEventListener( 'deviceorientation', this._onOrientation );

	}

	/** Takes the way the phone is held now as the middle again. */
	recentre() {

		this._started = false;

	}

	/** Eases the two copies after the latest reading. Call once a frame. */
	update( dt ) {

		const e = this._reading;
		if ( ! e ) return;

		const deg = THREE.MathUtils.DEG2RAD;
		const screenAngle = ( ( screen.orientation && screen.orientation.angle ) || window.orientation || 0 ) * deg;
		_euler.set( e.beta * deg, ( e.alpha || 0 ) * deg, - e.gamma * deg, 'YXZ' );
		this._device.setFromEuler( _euler ).multiply( _q1 ).multiply( _q0.setFromAxisAngle( _zee, - screenAngle ) );

		if ( ! this._started ) {

			this._quick.copy( this._device );
			this._slow.copy( this._device );
			this._started = true;

		}

		this._quick.slerp( this._device, 1 - Math.exp( - dt * FOLLOW ) );
		this._slow.slerp( this._quick, 1 - Math.exp( - dt * SETTLE ) );
		this.quaternion.copy( _inverse.copy( this._slow ).conjugate() ).multiply( this._quick );

		// the same turn as right / up, in the camera's own frame
		_euler.setFromQuaternion( this.quaternion, 'YXZ' );
		const clamp = v => Math.max( - 1, Math.min( 1, v ) );
		this.x = clamp( - _euler.y / RANGE );
		this.y = clamp( _euler.x / RANGE );
		this.active = true;

	}

}
