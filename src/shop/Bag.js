/**
 * ── BAG ────────────────────────────────────────────────────────────────────────
 * The shopping bag: lines of product, colour, size and quantity, kept in this browser
 * (localStorage) so it survives a reload. Until there is a server this is the whole of it;
 * then checkout sends `lines` to it, and the server — not this — prices the order.
 */
import { productById } from './catalog.js';

const KEY = 'kazmos.bag';
const MAX_QUANTITY = 9;

export class Bag {

	constructor() {

		this.lines = this._read();
		this._listeners = new Set();

	}

	_read() {

		try {

			const lines = JSON.parse( localStorage.getItem( KEY ) || '[]' );
			// drop anything the catalogue no longer has
			return Array.isArray( lines ) ? lines.filter( line => productById( line.id ) ) : [];

		} catch ( error ) {

			return [];

		}

	}

	_write() {

		try {

			localStorage.setItem( KEY, JSON.stringify( this.lines ) );

		} catch ( error ) { /* a private window: the bag lasts the visit */ }

		this._listeners.forEach( listener => listener( this ) );

	}

	/** Calls back with the bag whenever it changes; returns the unsubscribe. */
	subscribe( listener ) {

		this._listeners.add( listener );
		return () => this._listeners.delete( listener );

	}

	get count() {

		return this.lines.reduce( ( sum, line ) => sum + line.quantity, 0 );

	}

	get subtotal() {

		return this.lines.reduce( ( sum, line ) => sum + productById( line.id ).price * line.quantity, 0 );

	}

	add( id, colour, size, quantity = 1 ) {

		const key = `${ id }|${ colour }|${ size }`;
		const line = this.lines.find( other => other.key === key );
		if ( line ) line.quantity = Math.min( MAX_QUANTITY, line.quantity + quantity );
		else this.lines.push( { key, id, colour, size, quantity } );
		this._write();

	}

	setQuantity( key, quantity ) {

		const line = this.lines.find( other => other.key === key );
		if ( ! line ) return;
		if ( quantity <= 0 ) this.lines = this.lines.filter( other => other !== line );
		else line.quantity = Math.min( MAX_QUANTITY, quantity );
		this._write();

	}

	remove( key ) {

		this.setQuantity( key, 0 );

	}

	clear() {

		this.lines = [];
		this._write();

	}

}
