/**
 * ── TILT ───────────────────────────────────────────────────────────────────────
 * A phone's gyroscope as a pointer: how far it is tilted from the way it is being held, −1..1
 * each way (x right, y up), so the room inside the cabin shifts with the hand as it does with
 * a mouse. "The way it is held" follows the hand slowly, so a phone laid back or leant forward
 * settles and the room comes back to the middle.
 *
 * iOS asks the user first, and only from inside a tap: call request() from a pointer handler.
 */

// degrees of tilt from the rest pose that reach the edge of the parallax
const RANGE = 18;
// how quickly the rest pose follows the hand, per second
const SETTLE = 0.35;

export class Tilt {

	constructor() {

		this.x = 0;
		this.y = 0;
		this.active = false;
		this._rest = null;
		this._last = 0;
		this._listening = false;
		this._onOrientation = this._onOrientation.bind( this );

	}

	/** Whether this browser can report orientation at all. */
	get supported() {

		return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;

	}

	/** Starts listening, asking for permission where the browser needs it. Call from a tap. */
	request() {

		if ( ! this.supported || this._listening ) return;
		this._listening = true;

		const Orientation = window.DeviceOrientationEvent;
		if ( typeof Orientation.requestPermission === 'function' ) {

			Orientation.requestPermission()
				.then( state => { if ( state === 'granted' ) this._listen(); else this._listening = false; } )
				.catch( () => { this._listening = false; } );

		} else this._listen();

	}

	_listen() {

		window.addEventListener( 'deviceorientation', this._onOrientation );

	}

	_onOrientation( event ) {

		if ( event.beta === null || event.gamma === null ) return;

		// the device's tilts, turned to the screen's own right and up
		const angle = ( screen.orientation && screen.orientation.angle ) || window.orientation || 0;
		let right = event.gamma;
		let up = event.beta;
		if ( angle === 90 ) { right = event.beta; up = - event.gamma; }
		else if ( angle === - 90 || angle === 270 ) { right = - event.beta; up = event.gamma; }
		else if ( angle === 180 ) { right = - event.gamma; up = - event.beta; }

		const now = performance.now();
		const dt = this._last ? Math.min( 0.2, ( now - this._last ) / 1000 ) : 0;
		this._last = now;

		if ( ! this._rest ) this._rest = { right, up };
		const settle = 1 - Math.exp( - dt * SETTLE );
		this._rest.right += ( right - this._rest.right ) * settle;
		this._rest.up += ( up - this._rest.up ) * settle;

		const clamp = v => Math.max( - 1, Math.min( 1, v ) );
		this.x = clamp( ( right - this._rest.right ) / RANGE );
		// tipping the top away shows more of what is above, as raising a mouse does
		this.y = clamp( ( this._rest.up - up ) / RANGE );
		this.active = true;

	}

	/** Takes the way the phone is held now as the middle again. */
	recentre() {

		this._rest = null;

	}

}
