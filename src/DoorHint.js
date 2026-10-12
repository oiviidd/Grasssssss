/**
 * ── DOOR HINT ──────────────────────────────────────────────────────────────────
 * The invitation to open the cabin door: rings of warm light spreading from the door like
 * ripples, a hairline leading off it, and "Step inside" set beside it in the title's serif.
 * Pinned to the door and re-projected every frame, like the opening title, so it stays on
 * the door through the camera's handheld drift. The label sits on whichever side of the door
 * has more room.
 *
 * Once the room has been visited the label is not needed again; the rings stay, quieter.
 */

import * as THREE from '../vendor/three.module.js';

const _centre = new THREE.Vector3();
const _top = new THREE.Vector3();

export class DoorHint {

	/**
	 * @param element   #door-hint
	 * @param activate  called when the label itself is clicked or tapped
	 */
	constructor( element, activate ) {

		this.element = element;
		this.shown = false;

		const touch = typeof window.matchMedia === 'function' && window.matchMedia( '(pointer: coarse)' ).matches;
		const kicker = element.querySelector( '.door-hint-kicker' );
		if ( kicker ) kicker.textContent = touch ? 'Tap the door' : 'Click the door';

		const label = element.querySelector( '.door-hint-label' );
		if ( label ) label.addEventListener( 'click', event => {

			event.stopPropagation();
			activate();

		} );

	}

	show( on ) {

		if ( on === this.shown ) return;
		this.shown = on;

		const el = this.element;
		if ( on ) {

			el.hidden = false;
			// restart the entrance: drop the class, flush, put it back
			el.classList.remove( 'is-shown' );
			void el.offsetWidth;
			el.classList.add( 'is-shown' );

		} else {

			el.classList.remove( 'is-shown' );

		}

	}

	setHover( on ) {

		this.element.classList.toggle( 'is-hover', on );

	}

	/** After the first visit: rings only. */
	setKnown() {

		this.element.classList.add( 'is-known' );

	}

	/**
	 * @param centre  the door's centre, world space
	 * @param height  its height, world units
	 */
	place( camera, centre, height ) {

		if ( ! this.shown ) return;

		const width = window.innerWidth;
		const screenHeight = window.innerHeight;

		_centre.copy( centre ).project( camera );
		_top.copy( centre ).y += height / 2;
		_top.project( camera );

		const x = ( _centre.x + 1 ) * 0.5 * width;
		const y = ( 1 - _centre.y ) * 0.5 * screenHeight;
		const half = Math.abs( _top.y - _centre.y ) * 0.5 * screenHeight;

		const el = this.element;
		el.style.transform = `translate3d(${ x.toFixed( 1 ) }px, ${ y.toFixed( 1 ) }px, 0)`;
		el.style.setProperty( '--r', Math.max( 14, half ).toFixed( 1 ) + 'px' );
		el.classList.toggle( 'is-left', x > width * 0.5 );

	}

}
