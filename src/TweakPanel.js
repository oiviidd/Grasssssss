/**
 * Dependency-free tweak panel.
 *
 * Numeric fitting got the skyline and the palette right but kept missing what the scene
 * actually looks like, so this hands the dials over. Every value here maps to something
 * in shot.js, and "Copy config" emits a block that can be pasted straight back into it —
 * so a session of dragging sliders ends as a permanent change, not a lost state.
 *
 * Two classes of control, because they cost very different amounts:
 *   • camera — applied on the frame, free
 *   • grass and flowers — need a scatter rebuild, so they are debounced and show a
 *     "rebuilding" state rather than firing on every pixel of slider movement
 */

const STYLE = `
#tweak {
	position: fixed;
	top: 0;
	right: 0;
	width: 300px;
	max-height: 100vh;
	overflow-y: auto;
	padding: 14px 16px 18px;
	background: rgba(8, 26, 30, 0.86);
	backdrop-filter: blur(12px);
	border-left: 1px solid rgba(234, 246, 247, 0.14);
	color: #eaf6f7;
	font: 400 11px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	z-index: 30;
	pointer-events: auto;
}
#tweak.is-hidden { display: none; }
/* A phone has no T key, and the panel covers the very framing you open it to judge. */
#tweak-toggle {
	position: fixed;
	right: 10px;
	bottom: 10px;
	width: 34px;
	height: 34px;
	border: 1px solid rgba(234, 246, 247, 0.25);
	border-radius: 50%;
	background: rgba(8, 26, 30, 0.55);
	backdrop-filter: blur(8px);
	color: rgba(234, 246, 247, 0.75);
	font-size: 15px;
	line-height: 1;
	cursor: pointer;
	z-index: 31;
	-webkit-tap-highlight-color: transparent;
}
#tweak h2 {
	margin: 0 0 2px;
	font-size: 10px;
	font-weight: 500;
	letter-spacing: 0.18em;
	text-transform: uppercase;
}
#tweak .tweak-hint { margin: 0 0 14px; color: rgba(234,246,247,0.5); }
#tweak .tweak-group {
	margin: 0 0 6px;
	padding-top: 10px;
	border-top: 1px solid rgba(234,246,247,0.12);
	font-size: 10px;
	letter-spacing: 0.14em;
	text-transform: uppercase;
	color: rgba(234,246,247,0.65);
}
#tweak .tweak-row { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; margin-bottom: 7px; }
#tweak .tweak-row label { color: rgba(234,246,247,0.8); }
#tweak .tweak-row output { font-variant-numeric: tabular-nums; color: #eaf6f7; }
#tweak input[type=range] {
	grid-column: 1 / -1;
	width: 100%;
	height: 3px;
	margin: 3px 0 0;
	-webkit-appearance: none;
	appearance: none;
	background: rgba(234,246,247,0.22);
	border-radius: 2px;
	cursor: pointer;
}
#tweak input[type=range]::-webkit-slider-thumb {
	-webkit-appearance: none;
	width: 11px; height: 11px;
	border-radius: 50%;
	background: #eaf6f7;
	cursor: pointer;
}
#tweak input[type=range]::-moz-range-thumb {
	width: 11px; height: 11px; border: 0; border-radius: 50%; background: #eaf6f7; cursor: pointer;
}
#tweak .tweak-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
#tweak button {
	flex: 1 1 auto;
	padding: 7px 10px;
	border: 1px solid rgba(234,246,247,0.24);
	border-radius: 999px;
	background: transparent;
	color: rgba(234,246,247,0.85);
	font: inherit;
	cursor: pointer;
	transition: color 0.2s, border-color 0.2s, background-color 0.2s;
}
#tweak button:hover { color: #06181c; background: #eaf6f7; border-color: #eaf6f7; }
#tweak .tweak-status { margin: 10px 0 0; min-height: 1.5em; color: rgba(234,246,247,0.55); }
#tweak textarea {
	width: 100%;
	height: 150px;
	margin-top: 10px;
	padding: 8px;
	background: rgba(0,0,0,0.35);
	border: 1px solid rgba(234,246,247,0.18);
	border-radius: 6px;
	color: #eaf6f7;
	font: 400 10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
	resize: vertical;
}
#tweak label.tweak-check { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; cursor: pointer; }
#tweak .tweak-note { margin: 8px 0 4px; }
#tweak .tweak-note summary {
	cursor: pointer;
	color: rgba(234,246,247,0.6);
	font-size: 10px;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	list-style: none;
}
#tweak .tweak-note summary::-webkit-details-marker { display: none; }
#tweak .tweak-note ul {
	margin: 8px 0 0;
	padding-left: 15px;
	color: rgba(234,246,247,0.62);
	line-height: 1.6;
}
#tweak .tweak-note li { margin-bottom: 5px; }
#tweak .tweak-note code {
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 10px;
	color: rgba(234,246,247,0.9);
}
`;

export class TweakPanel {

	/**
	 * @param {object} options
	 *  - onChange(key, value, spec)  called live as a slider moves
	 *  - onCopy()                    returns the text for "Copy config"
	 */
	constructor( { onChange, onCopy } = {} ) {

		this.onChange = onChange || ( () => {} );
		this.onCopy = onCopy || ( () => '' );
		this.values = {};
		this.outputs = {};

		const style = document.createElement( 'style' );
		style.textContent = STYLE;
		document.head.appendChild( style );

		this.root = document.createElement( 'div' );
		this.root.id = 'tweak';
		document.body.appendChild( this.root );

		const heading = document.createElement( 'h2' );
		heading.textContent = 'Tweak';
		this.root.appendChild( heading );

		const hint = document.createElement( 'p' );
		hint.className = 'tweak-hint';
		hint.textContent = 'T hides this panel, or tap the dot.';
		this.root.appendChild( hint );

		// Tap target as well as the key, so the panel can be dismissed on a phone. Kept out
		// of `this.root` on purpose — it has to survive the panel being hidden.
		//
		// Named `toggleButton`, not `toggle`: this class already has a toggle() *method* for
		// checkbox rows, and assigning the element over it shadows the method on the instance,
		// so the first .toggle('freeze', ...) call dies and the whole scene fails to build.
		this.toggleButton = document.createElement( 'button' );
		this.toggleButton.id = 'tweak-toggle';
		this.toggleButton.type = 'button';
		this.toggleButton.title = 'Show/hide the tweak panel';
		this.toggleButton.textContent = '⚙';
		this.toggleButton.addEventListener( 'click', () => this.toggleVisibility() );
		document.body.appendChild( this.toggleButton );

		// `?clean` opens straight into the bare shot — the point of loading it on a device.
		if ( /(^|[?&#])clean/.test( location.search + location.hash ) ) {

			this.root.classList.add( 'is-hidden' );

		}

	}

	/** A row of buttons, each { label, onClick }. */
	buttons( items ) {

		const wrap = document.createElement( 'div' );
		wrap.className = 'tweak-actions';

		items.forEach( item => {

			const button = document.createElement( 'button' );
			button.textContent = item.label;
			button.addEventListener( 'click', () => item.onClick( this ) );
			wrap.appendChild( button );

		} );

		this.root.appendChild( wrap );
		return this;

	}

	/** Collapsible guidance block — kept in English for the 3D artist. */
	note( title, lines ) {

		const details = document.createElement( 'details' );
		details.className = 'tweak-note';

		const summary = document.createElement( 'summary' );
		summary.textContent = title;
		details.appendChild( summary );

		const list = document.createElement( 'ul' );
		lines.forEach( line => {

			const item = document.createElement( 'li' );
			item.innerHTML = line;
			list.appendChild( item );

		} );

		details.appendChild( list );
		this.root.appendChild( details );
		return this;

	}

	group( title ) {

		const el = document.createElement( 'div' );
		el.className = 'tweak-group';
		el.textContent = title;
		this.root.appendChild( el );
		return this;

	}

	/** A checkbox, for things that are on/off rather than numeric. */
	toggle( key, label, value ) {

		this.values[ key ] = value;

		const wrap = document.createElement( 'label' );
		wrap.className = 'tweak-check';

		const input = document.createElement( 'input' );
		input.type = 'checkbox';
		input.checked = value;

		const text = document.createElement( 'span' );
		text.textContent = label;

		input.addEventListener( 'change', () => {

			this.values[ key ] = input.checked;
			this.onChange( key, input.checked, { type: 'toggle' } );

		} );

		wrap.appendChild( input );
		wrap.appendChild( text );
		this.root.appendChild( wrap );

		return this;

	}

	/**
	 * @param {string} kind  'camera' applies live; 'rebuild' is debounced by the caller
	 */
	slider( key, label, value, min, max, step, kind = 'camera' ) {

		this.values[ key ] = value;

		const row = document.createElement( 'div' );
		row.className = 'tweak-row';

		const name = document.createElement( 'label' );
		name.textContent = label;

		const readout = document.createElement( 'output' );
		readout.textContent = this._format( value, step );

		const input = document.createElement( 'input' );
		input.type = 'range';
		input.min = min;
		input.max = max;
		input.step = step;
		input.value = value;

		input.addEventListener( 'input', () => {

			const next = Number( input.value );
			this.values[ key ] = next;
			readout.textContent = this._format( next, step );
			this.onChange( key, next, { kind } );

		} );

		row.appendChild( name );
		row.appendChild( readout );
		row.appendChild( input );
		this.root.appendChild( row );

		this.outputs[ key ] = { input, readout, step };

		return this;

	}

	_format( value, step ) {

		const decimals = step >= 1 ? 0 : String( step ).split( '.' )[ 1 ].length;
		return value.toFixed( decimals );

	}

	/**
	 * Widen or narrow a slider's travel after the fact.
	 *
	 * Grass extent is authored against the procedural hill's 4.9, but a sculpted hill sets
	 * its own. Without this the slider silently clamps the fitted value and the outermost
	 * band loses its grass the moment the slider is touched.
	 */
	range( key, min, max ) {

		const control = this.outputs[ key ];
		if ( ! control ) return this;

		// A range input only accepts min + n*step, and it snaps *max* down too when max is
		// off that grid — so a fitted 4.989 against a 0.05 step silently becomes 4.95 and
		// the outermost band of the hill loses its grass. Shift min instead, so the fitted
		// value is exactly reachable at the right-hand end.
		const alignedMin = max - Math.round( ( max - min ) / control.step ) * control.step;

		control.input.min = alignedMin;
		control.input.max = max;

		return this;

	}

	/** Push values back into the sliders — used after a fit or a reset. */
	set( key, value ) {

		this.values[ key ] = value;
		const control = this.outputs[ key ];
		if ( ! control ) return;

		control.input.value = value;
		control.readout.textContent = this._format( value, control.step );

	}

	actions( { onImport, onPaste } = {} ) {

		const wrap = document.createElement( 'div' );
		wrap.className = 'tweak-actions';

		const copy = document.createElement( 'button' );
		copy.textContent = 'Copy config';

		const download = document.createElement( 'button' );
		download.textContent = 'Download';

		wrap.appendChild( copy );
		wrap.appendChild( download );

		if ( onImport ) {

			const load = document.createElement( 'button' );
			load.textContent = 'Import file';
			load.addEventListener( 'click', () => onImport( this ) );
			wrap.appendChild( load );

		}

		if ( onPaste ) {

			const paste = document.createElement( 'button' );
			paste.textContent = 'Paste config';
			paste.addEventListener( 'click', () => onPaste( this ) );
			wrap.appendChild( paste );

		}
		this.root.appendChild( wrap );

		this.status = document.createElement( 'p' );
		this.status.className = 'tweak-status';
		this.root.appendChild( this.status );

		this.textarea = document.createElement( 'textarea' );
		this.textarea.placeholder = 'Config appears here on export — or paste one in and press "Paste config".';
		this.textarea.spellcheck = false;
		this.root.appendChild( this.textarea );

		copy.addEventListener( 'click', async () => {

			const text = this.onCopy();
			this.textarea.value = text;

			// Clipboard access can be refused outright depending on focus and permissions,
			// so the textarea is always filled first — it is the fallback, not a bonus.
			try {

				await navigator.clipboard.writeText( text );
				this.say( 'Copied. Paste it into src/shot.js.' );

			} catch ( error ) {

				this.textarea.select();
				this.say( 'Clipboard blocked — text is selected below, copy manually.' );

			}

		} );

		download.addEventListener( 'click', () => {

			const text = this.onCopy();
			this.textarea.value = text;

			const blob = new Blob( [ text ], { type: 'text/plain' } );
			const url = URL.createObjectURL( blob );
			const link = document.createElement( 'a' );

			link.href = url;
			link.download = 'shot-tuned.js';
			document.body.appendChild( link );
			link.click();
			document.body.removeChild( link );
			setTimeout( () => URL.revokeObjectURL( url ), 10000 );

			this.say( 'Saved shot-tuned.js to your downloads.' );

		} );

		return this;

	}

	say( message ) {

		if ( this.status ) this.status.textContent = message;

	}

	toggleVisibility() {

		this.root.classList.toggle( 'is-hidden' );

	}

}
