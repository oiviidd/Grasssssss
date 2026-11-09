/**
 * ── SHOP ───────────────────────────────────────────────────────────────────────
 * The shop's one panel and the bag button. Opened from the shelf or the rack, the panel
 * pours out of the thing that was clicked: a warm bloom of light spreads from it and the
 * panel opens as a circle from the same point, as the wash opened the door. Inside it there
 * are four views — a collection, a product, the bag, checkout — each coming in the way the
 * room's labels do, out of a blur into focus, a little after the one before.
 *
 * It knows nothing of the 3D scene. main.js tells it where a hotspot is on screen
 * (open's `origin`) and hears back which collection is showing (onCollection), to keep that
 * hotspot lit and step the room aside for it.
 *
 * Checkout stops short of payment: there is no server yet. It validates the address, keeps
 * the order in this browser and says plainly that nothing was charged — the gateway (Snapp
 * Pay, a card gateway) goes in `_placeOrder`.
 */
import { COLLECTIONS, CURRENCY, SHIPPING, productById, productsIn } from './catalog.js';

const ORDERS_KEY = 'kazmos.orders';
const money = CURRENCY.format;

const escape = text => String( text ).replace( /[&<>"']/g, c => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' } )[ c ] );

// Persian and Arabic digits typed into a field, as the ones the checks expect
const latinDigits = text => text.replace( /[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf( d ) ).replace( /[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf( d ) );

const reducedMotion = () => window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

/** A phone held upright gets the panel as a sheet from the bottom. */
const isSheet = () => window.matchMedia( '(max-width: 720px), (max-aspect-ratio: 4/5)' ).matches;

export class Shop {

	/**
	 * @param root        #shop
	 * @param button      #bag-button
	 * @param bag         Bag
	 * @param onCollection  called with 'shelf' | 'rack' | null as the panel shows one or none
	 */
	constructor( root, button, bag, { onCollection = () => {} } = {} ) {

		this.root = root;
		this.button = button;
		this.bag = bag;
		this.onCollection = onCollection;

		this.sheet = root.querySelector( '.shop-sheet' );
		this.body = root.querySelector( '.shop-body' );
		this.foot = root.querySelector( '.shop-foot' );
		this.crumb = root.querySelector( '.shop-crumb' );
		this.backButton = root.querySelector( '.shop-back' );
		this.bloom = root.querySelector( '.shop-bloom' );
		this.countEl = button.querySelector( '.bag-button-count' );

		this.isOpen = false;
		this.view = null;
		this._history = [];
		this._choice = {};
		this._returnFocus = null;
		this._closing = null;

		this.backButton.addEventListener( 'click', () => this.back() );
		root.querySelector( '.shop-close' ).addEventListener( 'click', () => this.close() );
		button.addEventListener( 'click', () => {

			if ( this.isOpen && this.view.type === 'bag' ) this.close();
			else this.open( { type: 'bag' }, { origin: this._centreOf( button ) } );

		} );
		root.addEventListener( 'keydown', event => { if ( event.key === 'Escape' ) { event.stopPropagation(); this.close(); } } );
		this._bindDrag();

		// the count changes as an added piece lands in the button, not as it leaves
		this._holdCount = false;
		bag.subscribe( () => { if ( ! this._holdCount ) this._renderCount( true ); } );
		this._renderCount( false );

	}

	/** The bag button comes in once there is something to look at. */
	showButton() {

		if ( ! this.button.hidden ) return;
		this.button.hidden = false;
		void this.button.offsetWidth;
		this.button.classList.add( 'is-shown' );

	}

	/* ── opening and closing ──────────────────────────────────────────────────── */

	/**
	 * @param view    { type: 'collection', id } | { type: 'product', id } | { type: 'bag' } | { type: 'checkout' }
	 * @param origin  { x, y } in CSS pixels: where it pours out of
	 */
	open( view, { origin } = {} ) {

		if ( this.isOpen ) {

			// already open: a new collection replaces the history; anything else is a step in
			if ( view.type === 'collection' ) this._history = [];
			else if ( this.view ) this._history.push( this.view );
			this._show( view );
			return;

		}

		clearTimeout( this._closing );
		this.isOpen = true;
		this._history = [];
		this._returnFocus = document.activeElement;
		document.body.classList.add( 'is-shopping' );

		const root = this.root;
		root.hidden = false;
		root.classList.remove( 'is-open', 'is-closing', 'was-open' );
		root.classList.toggle( 'is-sheet', isSheet() );
		document.body.classList.toggle( 'is-shop-sheet', isSheet() );
		this._show( view, { instant: true } );

		// the circle starts at the origin, as seen from the panel
		const at = origin || this._centreOf( this.sheet );
		this._origin = at;
		this._setReveal( at, 0 );
		this._pourBloom( at );
		void this.sheet.offsetWidth;
		root.classList.add( 'is-open' );
		this._setReveal( at, 1 );

		setTimeout( () => this.sheet.focus( { preventScroll: true } ), 60 );
		// views after the first come in without waiting for the panel
		setTimeout( () => { if ( this.isOpen ) root.classList.add( 'was-open' ); }, 900 );

	}

	close() {

		if ( ! this.isOpen ) return;
		this.isOpen = false;
		document.body.classList.remove( 'is-shopping' );
		this.onCollection( null );

		const root = this.root;
		root.classList.add( 'is-closing' );
		root.classList.remove( 'is-open' );
		this._setReveal( this._origin || this._centreOf( this.sheet ), 0 );
		this._closing = setTimeout( () => {

			root.hidden = true;
			root.classList.remove( 'is-closing' );
			this.sheet.style.transform = '';

		}, reducedMotion() ? 200 : 650 );

		if ( this._returnFocus && this._returnFocus.focus ) this._returnFocus.focus( { preventScroll: true } );

	}

	back() {

		const previous = this._history.pop();
		if ( previous ) this._show( previous, { backward: true } );
		else this.close();

	}

	/** The panel's circular reveal, from a point on screen: 0 shut, 1 fully open. */
	_setReveal( at, amount ) {

		const rect = this.sheet.getBoundingClientRect();
		const x = at.x - rect.left;
		const y = at.y - rect.top;
		const far = Math.max(
			Math.hypot( x, y ), Math.hypot( rect.width - x, y ),
			Math.hypot( x, rect.height - y ), Math.hypot( rect.width - x, rect.height - y ) );
		this.sheet.style.setProperty( '--reveal-x', `${ x }px` );
		this.sheet.style.setProperty( '--reveal-y', `${ y }px` );
		this.sheet.style.setProperty( '--reveal-r', `${ amount ? far + 40 : 0 }px` );

	}

	/** A blot of warm light that spreads from the origin as the panel opens. */
	_pourBloom( at ) {

		const bloom = this.bloom;
		bloom.style.left = `${ at.x }px`;
		bloom.style.top = `${ at.y }px`;
		bloom.classList.remove( 'is-pouring' );
		void bloom.offsetWidth;
		bloom.classList.add( 'is-pouring' );

	}

	_centreOf( element ) {

		const rect = element.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

	}

	/** On a phone the panel can be pulled down by its bar to close it. */
	_bindDrag() {

		const bar = this.root.querySelector( '.shop-bar' );
		let start = null;
		bar.addEventListener( 'pointerdown', event => {

			if ( ! this.root.classList.contains( 'is-sheet' ) || event.target.closest( 'button' ) ) return;
			start = { y: event.clientY, time: performance.now() };
			bar.setPointerCapture( event.pointerId );
			this.sheet.classList.add( 'is-dragging' );

		} );
		bar.addEventListener( 'pointermove', event => {

			if ( ! start ) return;
			this.sheet.style.transform = `translateY(${ Math.max( 0, event.clientY - start.y ) }px)`;

		} );
		const end = event => {

			if ( ! start ) return;
			const dy = event.clientY - start.y;
			const speed = dy / Math.max( 1, performance.now() - start.time );
			start = null;
			this.sheet.classList.remove( 'is-dragging' );
			if ( dy > 120 || speed > 0.6 ) this.close();
			else this.sheet.style.transform = '';

		};
		bar.addEventListener( 'pointerup', end );
		bar.addEventListener( 'pointercancel', end );

	}

	/* ── views ────────────────────────────────────────────────────────────────── */

	_show( view, { instant = false, backward = false } = {} ) {

		const from = this.view;
		this.view = view;
		this.onCollection( this._collectionOf( view ) );

		const render = () => {

			const { crumb, body, foot, bind } = this[ '_' + view.type ]( view );
			this.crumb.innerHTML = crumb;
			this.body.innerHTML = body;
			this.foot.innerHTML = foot || '';
			this.foot.hidden = ! foot;
			this.backButton.classList.toggle( 'is-shown', this._history.length > 0 );
			this.body.scrollTop = 0;
			this.root.dataset.view = view.type;
			if ( bind ) bind();
			// stagger the entrance
			this.sheet.classList.remove( 'is-entering', 'is-backward' );
			void this.sheet.offsetWidth;
			this.sheet.classList.toggle( 'is-backward', backward );
			this.sheet.classList.add( 'is-entering' );

		};

		if ( instant || ! from || reducedMotion() ) {

			render();
			return;

		}

		// the card's picture carries over into the product's, if that is the step
		const card = view.type === 'product' && from.type === 'collection'
			? this.body.querySelector( `.shop-card[data-id="${ view.id }"] .shop-card-image` ) : null;
		const fromRect = card && card.getBoundingClientRect();

		this.sheet.classList.add( 'is-leaving' );
		setTimeout( () => {

			this.sheet.classList.remove( 'is-leaving' );
			render();
			if ( fromRect ) this._carry( card.src, fromRect, this.body.querySelector( '.shop-hero-image' ) );

		}, 200 );

	}

	_collectionOf( view ) {

		if ( view.type === 'collection' ) return view.id;
		if ( view.type === 'product' ) return productById( view.id ).collection;
		return null;

	}

	/** The picture lifting from its card into the product's hero spot (FLIP). */
	_carry( src, fromRect, target ) {

		if ( ! target ) return;
		const toRect = target.getBoundingClientRect();
		if ( ! toRect.width ) return;
		const ghost = document.createElement( 'img' );
		ghost.src = src;
		ghost.className = 'shop-ghost';
		Object.assign( ghost.style, { left: `${ toRect.left }px`, top: `${ toRect.top }px`, width: `${ toRect.width }px`, height: `${ toRect.height }px` } );
		document.body.appendChild( ghost );
		target.style.opacity = '0';
		const dx = fromRect.left - toRect.left;
		const dy = fromRect.top - toRect.top;
		const s = fromRect.width / toRect.width;
		ghost.animate( [
			{ transform: `translate(${ dx }px, ${ dy }px) scale(${ s })` },
			{ transform: 'none' }
		], { duration: 620, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' } ).onfinish = () => {

			target.style.opacity = '';
			ghost.remove();

		};

	}

	/* collection ------------------------------------------------------------- */

	_collection( { id } ) {

		const collection = COLLECTIONS[ id ];
		const cards = productsIn( id ).map( ( product, i ) => `
			<button class="shop-card" type="button" data-id="${ product.id }" style="--i:${ i + 2 }">
				<span class="shop-card-frame">
					<span class="shop-card-light" aria-hidden="true"></span>
					<img class="shop-card-image" src="${ product.image }" alt="" draggable="false">
					<span class="shop-card-sheen" aria-hidden="true"></span>
				</span>
				<span class="shop-card-name">${ escape( product.name ) }</span>
				<span class="shop-card-meta">
					<span class="shop-card-price">${ money( product.price ) }</span>
					<span class="shop-card-swatches" aria-label="${ product.colours.length } colours">${ product.colours.map( ( [ , swatch ] ) => `<i style="--swatch:${ swatch }"></i>` ).join( '' ) }</span>
				</span>
			</button>` ).join( '' );

		return {
			crumb: '<span>Kazmos</span><span class="shop-crumb-sep"></span><span>The cabin</span>',
			body: `
				<header class="shop-intro" style="--i:0">
					<p class="shop-kicker">${ escape( collection.kicker ) }</p>
					<h2 class="shop-title">${ escape( collection.title ) }</h2>
					<p class="shop-blurb" style="--i:1">${ escape( collection.blurb ) }</p>
				</header>
				<div class="shop-grid" data-collection="${ id }">${ cards }</div>`,
			bind: () => this.body.querySelectorAll( '.shop-card' ).forEach( card =>
				card.addEventListener( 'click', () => this.open( { type: 'product', id: card.dataset.id } ) ) )
		};

	}

	/* product ---------------------------------------------------------------- */

	_product( { id } ) {

		const product = productById( id );
		const collection = COLLECTIONS[ product.collection ];
		const choice = this._choice[ id ] || ( this._choice[ id ] = {
			colour: product.colours[ 0 ][ 0 ],
			size: product.sizes.length === 1 ? product.sizes[ 0 ] : null
		} );

		const colours = product.colours.map( ( [ name, swatch ] ) => `
			<button class="shop-swatch${ name === choice.colour ? ' is-on' : '' }" type="button" data-colour="${ escape( name ) }"
				style="--swatch:${ swatch }" aria-label="${ escape( name ) }" aria-pressed="${ name === choice.colour }"></button>` ).join( '' );

		const sizes = product.sizes.length === 1
			? `<p class="shop-fixed">${ escape( product.sizes[ 0 ] ) }</p>`
			: `<div class="shop-sizes" role="radiogroup" aria-label="Size">${ product.sizes.map( size => `
				<button class="shop-size${ size === choice.size ? ' is-on' : '' }" type="button" role="radio" data-size="${ size }"
					aria-checked="${ size === choice.size }">${ size }</button>` ).join( '' ) }</div>`;

		return {
			crumb: `<span>${ escape( collection.kicker ) }</span><span class="shop-crumb-sep"></span><span>${ escape( product.name ) }</span>`,
			body: `
				<figure class="shop-hero" style="--i:0">
					<span class="shop-hero-light" aria-hidden="true"></span>
					<img class="shop-hero-image" src="${ product.image }" alt="${ escape( product.name ) }" draggable="false">
				</figure>
				<header class="shop-intro" style="--i:1">
					<p class="shop-kicker">${ escape( collection.kicker ) }</p>
					<h2 class="shop-title">${ escape( product.name ) }</h2>
					<p class="shop-price">${ money( product.price ) }</p>
				</header>
				<p class="shop-text" style="--i:2">${ escape( product.description ) }</p>
				<div class="shop-option" style="--i:3">
					<p class="shop-label">Colour <span class="shop-label-value" data-colour-name>${ escape( choice.colour ) }</span></p>
					<div class="shop-swatches">${ colours }</div>
				</div>
				<div class="shop-option" style="--i:4" data-size-option>
					<p class="shop-label">Size <span class="shop-label-value shop-hint" data-size-hint></span></p>
					${ sizes }
				</div>
				<ul class="shop-details" style="--i:5">${ product.details.map( detail => `<li>${ escape( detail ) }</li>` ).join( '' ) }</ul>`,
			foot: `
				<button class="shop-cta" type="button" data-add>
					<span class="shop-cta-text">Add to bag</span>
					<span class="shop-cta-price">${ money( product.price ) }</span>
				</button>`,
			bind: () => {

				const body = this.body;
				body.querySelectorAll( '.shop-swatch' ).forEach( button => button.addEventListener( 'click', () => {

					choice.colour = button.dataset.colour;
					body.querySelectorAll( '.shop-swatch' ).forEach( other => {

						other.classList.toggle( 'is-on', other === button );
						other.setAttribute( 'aria-pressed', other === button );

					} );
					body.querySelector( '[data-colour-name]' ).textContent = choice.colour;

				} ) );
				body.querySelectorAll( '.shop-size' ).forEach( button => button.addEventListener( 'click', () => {

					choice.size = button.dataset.size;
					body.querySelectorAll( '.shop-size' ).forEach( other => {

						other.classList.toggle( 'is-on', other === button );
						other.setAttribute( 'aria-checked', other === button );

					} );
					body.querySelector( '[data-size-hint]' ).textContent = '';
					body.querySelector( '[data-size-option]' ).classList.remove( 'is-wanting' );

				} ) );
				this.foot.querySelector( '[data-add]' ).addEventListener( 'click', event => {

					// just added, the button is the way to the bag
					if ( event.currentTarget.classList.contains( 'is-added' ) ) this.open( { type: 'bag' } );
					else this._add( product, choice, event.currentTarget );

				} );

			}
		};

	}

	_add( product, choice, cta ) {

		if ( ! choice.size ) {

			const option = this.body.querySelector( '[data-size-option]' );
			this.body.querySelector( '[data-size-hint]' ).textContent = '— choose one';
			option.classList.remove( 'is-wanting' );
			void option.offsetWidth;
			option.classList.add( 'is-wanting' );
			return;

		}

		this._holdCount = true;
		this.bag.add( product.id, choice.colour, choice.size );
		this._fly( this.body.querySelector( '.shop-hero-image' ) );

		cta.classList.add( 'is-added' );
		cta.querySelector( '.shop-cta-text' ).textContent = 'In your bag';
		cta.querySelector( '.shop-cta-price' ).innerHTML = '<span class="shop-cta-link">View bag</span>';
		clearTimeout( this._addedTimer );
		this._addedTimer = setTimeout( () => {

			if ( ! cta.isConnected ) return;
			cta.classList.remove( 'is-added' );
			cta.querySelector( '.shop-cta-text' ).textContent = 'Add to bag';
			cta.querySelector( '.shop-cta-price' ).textContent = money( product.price );

		}, 2600 );

	}

	/** A copy of the picture arcing into the bag button, which catches it. */
	_fly( image ) {

		if ( ! image || reducedMotion() ) {

			this._catch();
			return;

		}

		const from = image.getBoundingClientRect();
		const to = this.button.querySelector( '.bag-button-icon' ).getBoundingClientRect();
		const ghost = document.createElement( 'img' );
		ghost.src = image.src;
		ghost.className = 'shop-ghost is-flying';
		Object.assign( ghost.style, { left: `${ from.left }px`, top: `${ from.top }px`, width: `${ from.width }px`, height: `${ from.height }px` } );
		document.body.appendChild( ghost );

		// a quadratic arc that rises before it falls into the bag
		const x0 = 0, y0 = 0;
		const x2 = to.left + to.width / 2 - ( from.left + from.width / 2 );
		const y2 = to.top + to.height / 2 - ( from.top + from.height / 2 );
		const x1 = x2 * 0.35, y1 = Math.min( y0, y2 ) - 140;
		const end = Math.max( 0.06, to.width / from.width );
		const frames = [];
		for ( let i = 0; i <= 16; i ++ ) {

			const t = i / 16;
			const x = ( 1 - t ) * ( 1 - t ) * x0 + 2 * ( 1 - t ) * t * x1 + t * t * x2;
			const y = ( 1 - t ) * ( 1 - t ) * y0 + 2 * ( 1 - t ) * t * y1 + t * t * y2;
			const scale = 1 + ( end - 1 ) * t * t;
			frames.push( { transform: `translate(${ x }px, ${ y }px) scale(${ scale }) rotate(${ - 14 * t }deg)`, opacity: t > 0.9 ? ( 1 - t ) * 10 : 1, offset: t } );

		}

		ghost.animate( frames, { duration: 820, easing: 'cubic-bezier(0.45, 0, 0.2, 1)' } ).onfinish = () => {

			ghost.remove();
			this._catch();

		};

	}

	_catch() {

		this._holdCount = false;
		this._renderCount( true );
		const button = this.button;
		button.classList.remove( 'is-catching' );
		void button.offsetWidth;
		button.classList.add( 'is-catching' );

	}

	/* bag -------------------------------------------------------------------- */

	_bag() {

		const lines = this.bag.lines;
		if ( ! lines.length ) {

			return {
				crumb: '<span>Your bag</span>',
				body: `
					<div class="shop-empty" style="--i:0">
						<span class="shop-empty-mark" aria-hidden="true"></span>
						<h2 class="shop-title">Your bag is empty</h2>
						<p class="shop-text">Everything we make hangs in the cabin — on the shelf and on the rack.</p>
					</div>
					<div class="shop-empty-links" style="--i:1">
						<button class="shop-link" type="button" data-browse="shelf">The shelf</button>
						<button class="shop-link" type="button" data-browse="rack">The rack</button>
					</div>`,
				bind: () => this.body.querySelectorAll( '[data-browse]' ).forEach( button =>
					button.addEventListener( 'click', () => this.open( { type: 'collection', id: button.dataset.browse } ) ) )
			};

		}

		const rows = lines.map( ( line, i ) => {

			const product = productById( line.id );
			return `
				<li class="shop-line" data-key="${ escape( line.key ) }" style="--i:${ i + 1 }">
					<button class="shop-line-thumb" type="button" data-open="${ product.id }" aria-label="${ escape( product.name ) }">
						<img src="${ product.image }" alt="" draggable="false">
					</button>
					<div class="shop-line-info">
						<p class="shop-line-name">${ escape( product.name ) }</p>
						<p class="shop-line-meta">${ escape( line.colour ) } · ${ escape( line.size ) }</p>
						<div class="shop-stepper" aria-label="Quantity">
							<button type="button" data-step="-1" aria-label="One fewer">−</button>
							<span>${ line.quantity }</span>
							<button type="button" data-step="1" aria-label="One more">+</button>
						</div>
					</div>
					<div class="shop-line-end">
						<p class="shop-line-price">${ money( product.price * line.quantity ) }</p>
						<button class="shop-line-remove" type="button" data-remove>Remove</button>
					</div>
				</li>`;

		} ).join( '' );

		return {
			crumb: '<span>Your bag</span>',
			body: `
				<header class="shop-intro" style="--i:0">
					<p class="shop-kicker">${ this.bag.count } ${ this.bag.count === 1 ? 'piece' : 'pieces' }</p>
					<h2 class="shop-title">Your bag</h2>
				</header>
				<ul class="shop-lines">${ rows }</ul>`,
			foot: `
				<div class="shop-sum"><span>Subtotal</span><span>${ money( this.bag.subtotal ) }</span></div>
				<button class="shop-cta" type="button" data-checkout>
					<span class="shop-cta-text">Checkout</span>
					<span class="shop-cta-arrow" aria-hidden="true"></span>
				</button>`,
			bind: () => {

				this.body.querySelectorAll( '.shop-line' ).forEach( row => {

					const key = row.dataset.key;
					const line = () => this.bag.lines.find( other => other.key === key );
					row.querySelectorAll( '[data-step]' ).forEach( button => button.addEventListener( 'click', () => {

						const current = line();
						if ( ! current ) return;
						this.bag.setQuantity( key, current.quantity + Number( button.dataset.step ) );
						this._refreshBag( row );

					} ) );
					row.querySelector( '[data-remove]' ).addEventListener( 'click', () => {

						this.bag.remove( key );
						this._refreshBag( row );

					} );
					row.querySelector( '[data-open]' ).addEventListener( 'click', event => this.open( { type: 'product', id: event.currentTarget.dataset.open } ) );

				} );
				this.foot.querySelector( '[data-checkout]' ).addEventListener( 'click', () => this.open( { type: 'checkout' } ) );

			}
		};

	}

	/** After a change in the bag: a removed line folds away, the rest are re-read in place. */
	_refreshBag( row ) {

		const gone = ! this.bag.lines.find( line => line.key === row.dataset.key );
		const redraw = () => {

			const { body, foot, bind } = this._bag();
			const scroll = this.body.scrollTop;
			this.body.innerHTML = body;
			this.foot.innerHTML = foot || '';
			this.foot.hidden = ! foot;
			bind();
			this.body.scrollTop = scroll;
			this.sheet.classList.remove( 'is-entering' );

		};

		if ( gone && ! reducedMotion() ) {

			row.style.height = `${ row.offsetHeight }px`;
			void row.offsetWidth;
			row.classList.add( 'is-removing' );
			setTimeout( redraw, 380 );

		} else redraw();

	}

	/* checkout --------------------------------------------------------------- */

	_checkout() {

		if ( ! this.bag.lines.length ) return this._bag();

		const field = ( name, label, { type = 'text', autocomplete = '', inputmode = '', wide = false, placeholder = '', textarea = false } = {} ) => `
			<label class="shop-field${ wide ? ' is-wide' : '' }">
				<span class="shop-field-label">${ label }</span>
				${ textarea
		? `<textarea name="${ name }" rows="2" autocomplete="${ autocomplete }" placeholder="${ placeholder }"></textarea>`
		: `<input name="${ name }" type="${ type }" autocomplete="${ autocomplete }"${ inputmode ? ` inputmode="${ inputmode }"` : '' } placeholder="${ placeholder }">` }
				<span class="shop-field-error" aria-live="polite"></span>
			</label>`;

		const shipping = SHIPPING.map( ( option, i ) => `
			<label class="shop-ship">
				<input type="radio" name="shipping" value="${ option.id }"${ i === 0 ? ' checked' : '' }>
				<span class="shop-ship-card">
					<span class="shop-ship-name">${ escape( option.name ) }</span>
					<span class="shop-ship-note">${ escape( option.note ) }</span>
					<span class="shop-ship-price">${ money( option.price ) }</span>
				</span>
			</label>` ).join( '' );

		return {
			crumb: '<span>Your bag</span><span class="shop-crumb-sep"></span><span>Checkout</span>',
			body: `
				<header class="shop-intro" style="--i:0">
					<p class="shop-kicker">Step 1 of 2</p>
					<h2 class="shop-title">Where to?</h2>
				</header>
				<form class="shop-form" novalidate style="--i:1">
					${ field( 'name', 'Full name', { autocomplete: 'name', wide: true } ) }
					${ field( 'phone', 'Mobile', { type: 'tel', autocomplete: 'tel', inputmode: 'numeric', placeholder: '09…' } ) }
					${ field( 'postcode', 'Postal code', { autocomplete: 'postal-code', inputmode: 'numeric', placeholder: '10 digits' } ) }
					${ field( 'province', 'Province', { autocomplete: 'address-level1' } ) }
					${ field( 'city', 'City', { autocomplete: 'address-level2' } ) }
					${ field( 'address', 'Street address', { autocomplete: 'street-address', wide: true, textarea: true } ) }
				</form>
				<div class="shop-option" style="--i:2">
					<p class="shop-label">Delivery</p>
					<div class="shop-ships">${ shipping }</div>
				</div>
				<div class="shop-summary" style="--i:3">
					<div class="shop-sum"><span>Subtotal</span><span>${ money( this.bag.subtotal ) }</span></div>
					<div class="shop-sum"><span>Delivery</span><span data-shipping-price></span></div>
				</div>`,
			foot: `
				<div class="shop-sum is-total"><span>Total</span><span data-total></span></div>
				<button class="shop-cta" type="button" data-place>
					<span class="shop-cta-text">Continue to payment</span>
					<span class="shop-cta-arrow" aria-hidden="true"></span>
				</button>`,
			bind: () => {

				const body = this.body;
				const form = body.querySelector( '.shop-form' );
				const totals = () => {

					const option = SHIPPING.find( s => s.id === body.querySelector( '[name="shipping"]:checked' ).value );
					body.querySelector( '[data-shipping-price]' ).textContent = money( option.price );
					this.foot.querySelector( '[data-total]' ).textContent = money( this.bag.subtotal + option.price );
					return option;

				};
				totals();
				body.querySelectorAll( '[name="shipping"]' ).forEach( radio => radio.addEventListener( 'change', totals ) );
				// a field's complaint goes once it is being fixed
				form.addEventListener( 'input', event => {

					const label = event.target.closest( '.shop-field' );
					if ( label ) label.classList.remove( 'is-wrong' );

				} );
				// remember the address in this browser
				const saved = this._savedAddress();
				Object.entries( saved ).forEach( ( [ name, value ] ) => { if ( form.elements[ name ] ) form.elements[ name ].value = value; } );
				this.foot.querySelector( '[data-place]' ).addEventListener( 'click', () => this._placeOrder( form, totals() ) );

			}
		};

	}

	_savedAddress() {

		try {

			return JSON.parse( localStorage.getItem( 'kazmos.address' ) || '{}' );

		} catch ( error ) {

			return {};

		}

	}

	_validate( form ) {

		const value = name => latinDigits( form.elements[ name ].value.trim() );
		const problems = {};
		if ( value( 'name' ).length < 3 ) problems.name = 'Your full name, please';
		if ( ! /^09\d{9}$/.test( value( 'phone' ).replace( /[\s-]/g, '' ) ) ) problems.phone = 'An 11-digit mobile, starting 09';
		if ( ! /^\d{10}$/.test( value( 'postcode' ).replace( /[\s-]/g, '' ) ) ) problems.postcode = 'Ten digits';
		if ( ! value( 'province' ) ) problems.province = 'Required';
		if ( ! value( 'city' ) ) problems.city = 'Required';
		if ( value( 'address' ).length < 8 ) problems.address = 'Street, building and unit';

		form.querySelectorAll( '.shop-field' ).forEach( label => {

			const name = label.querySelector( 'input, textarea' ).name;
			label.classList.toggle( 'is-wrong', !! problems[ name ] );
			label.querySelector( '.shop-field-error' ).textContent = problems[ name ] || '';

		} );

		return Object.keys( problems ).length ? null : {
			name: value( 'name' ), phone: value( 'phone' ).replace( /[\s-]/g, '' ), postcode: value( 'postcode' ).replace( /[\s-]/g, '' ),
			province: value( 'province' ), city: value( 'city' ), address: value( 'address' )
		};

	}

	/**
	 * Where payment will go. For now: the order is kept in this browser and the bag emptied,
	 * and the confirmation says that nothing was charged.
	 */
	_placeOrder( form, shipping ) {

		const address = this._validate( form );
		if ( ! address ) {

			const wrong = form.querySelector( '.is-wrong input, .is-wrong textarea' );
			if ( wrong ) wrong.focus();
			return;

		}

		const order = {
			number: 'KZ-' + Date.now().toString( 36 ).toUpperCase().slice( - 6 ),
			placedAt: new Date().toISOString(),
			lines: this.bag.lines.map( line => ( { ...line, price: productById( line.id ).price } ) ),
			shipping: shipping.id,
			total: this.bag.subtotal + shipping.price,
			address
		};

		try {

			localStorage.setItem( 'kazmos.address', JSON.stringify( address ) );
			const orders = JSON.parse( localStorage.getItem( ORDERS_KEY ) || '[]' );
			orders.push( order );
			localStorage.setItem( ORDERS_KEY, JSON.stringify( orders ) );

		} catch ( error ) { /* kept for the visit only */ }

		this.bag.clear();
		this._history = [];
		this._show( { type: 'placed', order } );

	}

	_placed( { order } ) {

		return {
			crumb: '<span>Order placed</span>',
			body: `
				<div class="shop-done" style="--i:0">
					<span class="shop-done-mark" aria-hidden="true"></span>
					<p class="shop-kicker">Order ${ escape( order.number ) }</p>
					<h2 class="shop-title">Thank you, ${ escape( order.address.name.split( ' ' )[ 0 ] ) }</h2>
					<p class="shop-text">It will be wrapped and on its way to ${ escape( order.address.city ) } soon. We will text ${ escape( order.address.phone ) } when it leaves.</p>
				</div>
				<p class="shop-note" style="--i:1">This is a preview of the shop: no payment was taken. The payment gateway connects at this step.</p>`,
			foot: `
				<button class="shop-cta is-quiet" type="button" data-done>
					<span class="shop-cta-text">Back to the cabin</span>
				</button>`,
			bind: () => this.foot.querySelector( '[data-done]' ).addEventListener( 'click', () => this.close() )
		};

	}

	/* the bag button ---------------------------------------------------------- */

	_renderCount( animate ) {

		const count = this.bag.count;
		const el = this.countEl;
		this.button.classList.toggle( 'has-items', count > 0 );
		this.button.setAttribute( 'aria-label', `Bag, ${ count } ${ count === 1 ? 'item' : 'items' }` );
		const old = el.querySelector( 'span' );
		if ( old && old.textContent === String( count ) ) return;
		const next = document.createElement( 'span' );
		next.textContent = count;
		if ( ! animate || ! old || reducedMotion() ) {

			el.replaceChildren( next );
			return;

		}

		// the old number rolls up and away, the new one up into its place
		const up = count > Number( old.textContent );
		next.classList.add( up ? 'is-from-below' : 'is-from-above' );
		old.classList.add( up ? 'is-to-above' : 'is-to-below' );
		el.appendChild( next );
		setTimeout( () => old.remove(), 450 );

	}

}
