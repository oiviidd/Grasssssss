/**
 * ── ROOM LABEL ─────────────────────────────────────────────────────────────────
 * The name of what the pointer is on inside the cabin — the shelf or the rack — set the way
 * the door's invitation is: a hairline drawn off the thing, a small kicker, and the name in
 * the title's serif. It hangs from a point on the painting (Interior.anchor) and follows it
 * as the room pans.
 */

const COPY = {
	shelf: { kicker: 'Caps & beanies', title: 'The shelf' },
	rack: { kicker: 'Coats & shirts', title: 'The rack' }
};

export class RoomLabel {

	/** @param element  #room-label */
	constructor( element ) {

		this.element = element;
		this.id = null;
		this.kicker = element.querySelector( '.room-label-kicker' );
		this.title = element.querySelector( '.room-label-title' );

	}

	/** Shows the label for a hotspot, or hides it with null. */
	show( id ) {

		if ( id === this.id ) return;
		this.id = id;

		const el = this.element;
		el.classList.remove( 'is-shown' );
		if ( ! id ) return;

		const copy = COPY[ id ];
		this.kicker.textContent = copy.kicker;
		this.title.textContent = copy.title;
		el.hidden = false;
		// restart the entrance: drop the class, flush, put it back
		void el.offsetWidth;
		el.classList.add( 'is-shown' );

	}

	/** @param anchor  { x, y } on screen, 0..1 with y down, and the side it reads to: left, right, above, below */
	place( anchor ) {

		const el = this.element;
		// on a phone the crop can leave the anchor off the edge; the label stays on screen
		const x = Math.min( window.innerWidth - 8, Math.max( 8, anchor.x * window.innerWidth ) );
		// a narrow screen may not have the room on the painting's side; it reads the other way
		// the text, plus the lead and the gap before it
		const room = this.title.parentElement.offsetWidth + Math.min( 72, Math.max( 36, window.innerWidth * 0.048 ) );
		let side = anchor.side;
		if ( side === 'left' && x < room ) side = 'right';
		else if ( side === 'right' && x > window.innerWidth - room ) side = 'left';
		el.style.transform = `translate3d(${ x }px, ${ anchor.y * window.innerHeight }px, 0)`;
		el.classList.toggle( 'is-left', side === 'left' );
		el.classList.toggle( 'is-above', side === 'above' );
		el.classList.toggle( 'is-below', side === 'below' );
		// an upright lead can be drawn longer, to clear what lies between (the rifle, over the shelf)
		if ( anchor.lead ) el.style.setProperty( '--lead-v', `${ anchor.lead * window.innerHeight }px` );
		else el.style.removeProperty( '--lead-v' );

	}

}
