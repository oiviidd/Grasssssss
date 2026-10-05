/**
 * ── INTRO ──────────────────────────────────────────────────────────────────────
 * The opening of the page: the camera starts low in the grass looking up into the sky,
 * where "Welcome to Kazmos" is written, then cranes back and down to the hero shot.
 *
 * The title is DOM rather than geometry — real type, crisp at any size — but it is pinned
 * to a point far out in the sky and re-projected every frame. As the camera tilts down the
 * title rises out of frame with the sky, instead of sliding off a layer stuck to the glass.
 *
 * It only ever drives the camera's *anchor*. The mountain and cabin are placed against the
 * hero shot, never against this, so the whole move happens inside one fixed world.
 *
 * Timeline: `hold` with the title revealing (the reveal itself is CSS, style.css), then
 * `flight` seconds of camera move, during which the title blurs out. Under
 * prefers-reduced-motion there is no flight: the title fades and the camera cuts.
 */

import * as THREE from '../vendor/three.module.js';

// How far out the title's point sits. Far enough that the camera's own travel barely moves
// it, so it behaves like the sky behind it: only the tilt carries it.
const SKY_DISTANCE = 60;

// Life in the held frame: a slow push in and a breath of upward tilt, over the whole hold.
const HOLD_PUSH = 0.05;
const HOLD_TILT = 0.012;

const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow( - 2 * t + 2, 3 ) / 2;
const easeInOutSine = t => - ( Math.cos( Math.PI * t ) - 1 ) / 2;
const clamp01 = t => Math.min( 1, Math.max( 0, t ) );
const smoothstep = ( a, b, x ) => {

	const t = clamp01( ( x - a ) / ( b - a ) );
	return t * t * ( 3 - 2 * t );

};

/** Shortest way round between two angles. */
function lerpAngle( a, b, t ) {

	let d = ( b - a ) % ( Math.PI * 2 );
	if ( d > Math.PI ) d -= Math.PI * 2;
	if ( d < - Math.PI ) d += Math.PI * 2;
	return a + d * t;

}

export class Intro {

	/**
	 * @param element  the #intro element, holding .intro-kicker and .intro-title
	 * @param config   INTRO from shot.js
	 */
	constructor( element, config ) {

		this.element = element;
		this.config = config;

		this.state = 'idle'; // idle → hold → flight → done
		this.time = 0;

		this.reduced = typeof window.matchMedia === 'function' &&
			window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

		this._anchor = new THREE.Vector3();
		this._ndc = new THREE.Vector3();
		this._anchorPending = true;

		// Where the flight leaves from: wherever the hold had drifted to.
		this._from = { position: [ 0, 0, 0 ], rotation: [ 0, 0, 0 ], fov: 30 };
		this._pose = { position: [ 0, 0, 0 ], rotation: [ 0, 0, 0 ], fov: 30 };

		this._splitTitle();

	}

	get active() {

		return this.state === 'hold' || this.state === 'flight';

	}

	/** From the top: back in the grass, title revealing again. */
	start() {

		this.state = 'hold';
		this.time = 0;
		this._anchorPending = true;

		const el = this.element;
		el.hidden = false;
		el.style.opacity = '';
		el.style.filter = '';

		// Restart the CSS reveal: drop the class, force a style flush, put it back.
		el.classList.remove( 'is-playing' );
		void el.offsetWidth;
		el.classList.add( 'is-playing' );

	}

	/** A click, tap or key during the hold: move now rather than wait it out. */
	skip() {

		if ( this.state === 'hold' ) this._beginFlight();

	}

	/** Straight to the end — for anything that takes the camera over mid-flight. */
	finish() {

		if ( this.state === 'idle' || this.state === 'done' ) return;

		this.state = 'done';
		this.element.hidden = true;
		this.element.classList.remove( 'is-playing' );

	}

	/** The title's point needs re-solving — the viewport changed shape. */
	invalidate() {

		this._anchorPending = true;

	}

	/**
	 * Advances the timeline and returns this frame's camera pose: { position, rotation, fov },
	 * rotation as [ pitch, yaw, roll ] the way the rig takes it. On the frame it ends, the
	 * pose is exactly `to`.
	 *
	 * @param to  the hero pose, in the same shape
	 */
	update( dt, to ) {

		const config = this.config;
		const start = config.camera;
		const pose = this._pose;

		this.time += dt;

		if ( this.state === 'hold' ) {

			const s = easeInOutSine( clamp01( this.time / config.hold ) );
			const layout = this._layout();
			const yaw = layout.yaw;

			pose.position[ 0 ] = start.position[ 0 ] - Math.sin( yaw ) * HOLD_PUSH * s;
			pose.position[ 1 ] = start.position[ 1 ];
			pose.position[ 2 ] = start.position[ 2 ] - Math.cos( yaw ) * HOLD_PUSH * s;
			pose.rotation[ 0 ] = layout.pitch + HOLD_TILT * s;
			pose.rotation[ 1 ] = yaw;
			pose.rotation[ 2 ] = 0;
			pose.fov = start.fov;

			if ( this.time >= config.hold ) this._beginFlight();

			return pose;

		}

		// flight
		const from = this._from;
		const u = this.reduced ? ( this.time >= 0.8 ? 1 : 0 ) : clamp01( this.time / config.flight );

		// The pull back leads and the tilt follows a beat behind, the way a crane move reads:
		// the camera lifts out of the grass first, then settles its gaze on the meadow.
		const p = easeInOutCubic( u );
		const r = easeInOutCubic( clamp01( ( u - 0.06 ) / 0.94 ) );

		for ( let i = 0; i < 3; i ++ ) pose.position[ i ] = from.position[ i ] + ( to.position[ i ] - from.position[ i ] ) * p;
		pose.rotation[ 0 ] = from.rotation[ 0 ] + ( to.rotation[ 0 ] - from.rotation[ 0 ] ) * r;
		pose.rotation[ 1 ] = lerpAngle( from.rotation[ 1 ], to.rotation[ 1 ], r );
		pose.rotation[ 2 ] = 0;
		pose.fov = from.fov + ( to.fov - from.fov ) * p;

		// The title goes soft and fades as the move gets under way, long enough to be seen
		// riding up with the sky, and gone well before the camera settles so the hero shot
		// lands clean.
		const exit = this.reduced ? clamp01( this.time / 0.8 ) : smoothstep( 0.04, 0.6, u );
		this.element.style.opacity = String( 1 - exit );
		this.element.style.filter = exit > 0.001 ? `blur(${ ( exit * 10 ).toFixed( 2 ) }px)` : '';

		if ( u >= 1 ) {

			pose.position = to.position.slice();
			pose.rotation = to.rotation.slice();
			pose.fov = to.fov;
			this.finish();

		}

		return pose;

	}

	/**
	 * Puts the title over its point in the sky as `camera` sees it this frame. Call after the
	 * camera has been moved for the frame.
	 */
	placeTitle( camera ) {

		if ( ! this.active ) return;

		const width = window.innerWidth;
		const height = window.innerHeight;
		if ( ! width || ! height ) return;

		// Solved from the frame the title is first seen in: its NDC spot, pushed out along the
		// view ray to the sky. Reduced motion keeps it there on screen instead, since that
		// camera cuts rather than moves.
		if ( this._anchorPending ) {

			const layout = this._layout();

			this._anchor.set( layout.x, layout.y, 0.5 ).unproject( camera )
				.sub( camera.position ).normalize()
				.multiplyScalar( SKY_DISTANCE ).add( camera.position );

			this._anchorPending = false;

		}

		const ndc = this._ndc.copy( this._anchor ).project( camera );
		if ( this.reduced && this.state === 'flight' ) return;

		const x = ( ndc.x + 1 ) * 0.5 * width;
		const y = ( 1 - ndc.y ) * 0.5 * height;
		this.element.style.transform = `translate3d(${ x.toFixed( 1 ) }px, ${ y.toFixed( 1 ) }px, 0)`;

	}

	_beginFlight() {

		const from = this._from;
		from.position = this._pose.position.slice();
		from.rotation = this._pose.rotation.slice();
		from.fov = this._pose.fov;

		this.state = 'flight';
		this.time = 0;

	}

	/**
	 * The opening frame for this viewport shape, between the wide and narrow layouts: the
	 * title's NDC spot, and which way the camera looks. A layout without its own rotation
	 * looks the way `camera` does.
	 */
	_layout() {

		const { camera, wide, narrow } = this.config;
		const width = window.innerWidth;
		const height = window.innerHeight;
		const aspect = width > 0 && height > 0 ? width / height : 1;
		const t = clamp01( ( wide.aspect - aspect ) / ( wide.aspect - narrow.aspect ) );

		const wideRotation = wide.rotation || camera.rotation;
		const narrowRotation = narrow.rotation || camera.rotation;

		return {
			x: wide.x + ( narrow.x - wide.x ) * t,
			y: wide.y + ( narrow.y - wide.y ) * t,
			pitch: wideRotation[ 0 ] + ( narrowRotation[ 0 ] - wideRotation[ 0 ] ) * t,
			yaw: lerpAngle( wideRotation[ 1 ], narrowRotation[ 1 ], t )
		};

	}

	/**
	 * One span per letter, for the staggered reveal — twice over: the letters themselves, and
	 * an identical layer above them that carries the glint. Splitting drops the font's own
	 * kerning, so both layers must be split the same way to stay in register.
	 */
	_splitTitle() {

		const title = this.element.querySelector( '.intro-title' );
		if ( ! title || title.dataset.split ) return;

		const word = title.textContent.trim();
		const centre = ( word.length - 1 ) / 2;

		const letters = layer => [ ...word ].map( ( char, i ) => {

			const span = document.createElement( 'span' );
			span.className = 'intro-char';
			span.textContent = char;
			// Out from the middle of the word, rather than left to right.
			span.style.setProperty( '--i', Math.abs( i - centre ).toFixed( 2 ) );
			layer.appendChild( span );
			return span;

		} );

		title.setAttribute( 'aria-label', word );
		title.textContent = '';

		const base = document.createElement( 'span' );
		base.className = 'intro-letters';
		base.setAttribute( 'aria-hidden', 'true' );
		letters( base );

		const glint = document.createElement( 'span' );
		glint.className = 'intro-letters intro-glint';
		glint.setAttribute( 'aria-hidden', 'true' );
		letters( glint );

		title.append( base, glint );
		title.dataset.split = '1';

	}

}

/**
 * Resolves once the title's typefaces are in, so it never reveals in a fallback font and
 * swaps mid-animation. Gives up after `timeout` ms — offline, the system font will do.
 */
export function waitForTitleFonts( timeout = 3000 ) {

	const fonts = document.fonts;
	if ( ! fonts || typeof fonts.load !== 'function' ) return Promise.resolve();

	const link = document.getElementById( 'intro-fonts' );

	// fonts.load() answers straight away while the stylesheet that declares the faces is
	// still in flight, so wait for the sheet first.
	const sheet = link && ! link.sheet
		? new Promise( resolve => {

			link.addEventListener( 'load', resolve, { once: true } );
			link.addEventListener( 'error', resolve, { once: true } );

		} )
		: Promise.resolve();

	const loaded = sheet.then( () => Promise.all( [
		fonts.load( '400 100px "Instrument Serif"' ),
		fonts.load( '500 14px "Inter Tight"' )
	] ) ).catch( () => null );

	return Promise.race( [ loaded, new Promise( resolve => setTimeout( resolve, timeout ) ) ] );

}
