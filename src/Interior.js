/**
 * ── INTERIOR ───────────────────────────────────────────────────────────────────
 * The room behind the cabin door: one painting in three lights — day, sunset, night — drawn
 * full screen and brought to life in glsl/interior.js. Which light is up follows the scene's
 * own clock, so the room is lit the way the meadow outside was, and a double Space runs it
 * through the day in here too.
 *
 * The paintings are a few hundred kB each and nothing needs them before the door is opened,
 * so they load after the page is up (preload()), not with the scene.
 */

import * as THREE from '../vendor/three.module.js';
import * as FboHelper from './FboHelper.js';
import { quadVert } from './glsl/post.js';
import { interiorFrag } from './glsl/interior.js';

const PATH = 'assets/interior/';
const LIGHTS = [ 'day', 'sunset', 'night' ];

// How far past the screen's edge the picture is cropped, so the parallax never runs out of it.
const BASE_ZOOM = 1.012;

// Pointer parallax easing, and the slow drift that keeps a still pointer (or a phone) alive.
const PARALLAX_EASE = 2.5;
const DRIFT = 0.35;

// Portrait screens see a narrow slice of the picture; a drag pans it, and it eases back.
const PAN_RANGE = 0.5;

/*
 * The room is painted twice: landscape for wide screens, and portrait — the same room
 * recomposed round the shelf and rack — for screens held upright. Each set has its three
 * lights, its own hand-drawn masks (paint, below) and its own hotspots, all in that painting's
 * 0..1 coordinates with y down. The portrait sunset and night were warped onto the portrait
 * day, so all three line up.
 *
 * Hotspots: the shelf with its caps and beanies, and the rack with its coats, traced round
 * their silhouettes. `anchor` is where the label hangs from and `side` which way it reads
 * (left, right, above, below), `lead` an upright lead's length in screen heights; `centre`
 * is what the hover leans toward.
 *
 *   hang      image rows the coats hang over, shoulders to hems — how far down they sway
 *   horizon   the row where the sky in the windows meets the meadow
 */
const SETS = {
	landscape: {
		path: PATH,
		aspect: 1672 / 941,
		hang: [ 0.47, 1.0 ],
		horizon: 0.45,
		hotspots: {
			shelf: {
				poly: [
					[ 0.285, 0.312 ], [ 0.296, 0.304 ], [ 0.307, 0.268 ], [ 0.321, 0.237 ], [ 0.34, 0.233 ], [ 0.36, 0.248 ],
					[ 0.372, 0.272 ], [ 0.384, 0.24 ], [ 0.404, 0.232 ], [ 0.425, 0.245 ], [ 0.437, 0.268 ], [ 0.452, 0.262 ],
					[ 0.459, 0.232 ], [ 0.474, 0.207 ], [ 0.496, 0.207 ], [ 0.513, 0.229 ], [ 0.519, 0.258 ], [ 0.535, 0.229 ],
					[ 0.565, 0.233 ], [ 0.585, 0.262 ], [ 0.592, 0.25 ], [ 0.605, 0.221 ], [ 0.609, 0.196 ], [ 0.62, 0.192 ],
					[ 0.633, 0.202 ], [ 0.64, 0.232 ], [ 0.646, 0.236 ], [ 0.661, 0.223 ], [ 0.685, 0.227 ], [ 0.696, 0.26 ],
					[ 0.7, 0.304 ], [ 0.714, 0.312 ], [ 0.714, 0.327 ], [ 0.669, 0.332 ], [ 0.667, 0.338 ], [ 0.664, 0.413 ],
					[ 0.655, 0.413 ], [ 0.655, 0.334 ], [ 0.355, 0.334 ], [ 0.355, 0.416 ], [ 0.343, 0.416 ], [ 0.335, 0.34 ],
					[ 0.335, 0.332 ], [ 0.287, 0.328 ]
				],
				centre: [ 0.5, 0.29 ],
				anchor: [ 0.285, 0.27 ],
				side: 'left'
			},
			rack: {
				poly: [
					[ 0.272, 0.406 ], [ 0.288, 0.401 ], [ 0.297, 0.458 ], [ 0.683, 0.458 ], [ 0.684, 0.437 ], [ 0.698, 0.434 ],
					[ 0.702, 0.46 ], [ 0.702, 0.578 ], [ 0.712, 0.59 ], [ 0.729, 0.65 ], [ 0.741, 0.75 ], [ 0.749, 0.84 ],
					[ 0.756, 0.92 ], [ 0.762, 0.995 ], [ 0.304, 0.995 ], [ 0.301, 0.84 ], [ 0.296, 0.827 ], [ 0.28, 0.797 ],
					[ 0.286, 0.788 ], [ 0.297, 0.8 ], [ 0.296, 0.668 ], [ 0.296, 0.632 ], [ 0.283, 0.524 ]
				],
				centre: [ 0.52, 0.7 ],
				anchor: [ 0.765, 0.72 ],
				side: 'right'
			}
		},
		paint( d, layer ) {

			if ( layer === 'depth' ) {

				d.rect( 0.35, 0, 0, 1, 1 );                          // the back wall
				d.rect( 0.45, 0, 0.055, 0.262, 0.665 );              // left window, frame and sill
				d.rect( 0.45, 0.733, 0.055, 1, 0.665 );              // right window
				d.rect( 0.0, 0.03, 0.128, 0.224, 0.582 );            // the view out of them
				d.rect( 0.0, 0.772, 0.128, 0.962, 0.587 );
				d.rect( 0.45, 0.113, 0.128, 0.132, 0.582 );          // their glazing bars
				d.rect( 0.45, 0.03, 0.335, 0.224, 0.37 );
				d.rect( 0.45, 0.857, 0.128, 0.877, 0.587 );
				d.rect( 0.45, 0.772, 0.335, 0.962, 0.37 );
				d.rect( 0.44, 0.319, 0.03, 0.682, 0.16 );            // the rifle
				d.poly( 0.55, this.hotspots.shelf.poly );            // shelf and hats
				d.floor( 0.9, [ [ 0, 0.27 ], [ 0.77, 1 ] ] );         // the floor, nearer lower down
				d.poly( 0.85, this.hotspots.rack.poly );             // rack and coats

			} else if ( layer === 'cloth' ) {

				d.poly( 1, [ [ 0.31, 0.50 ], [ 0.70, 0.50 ], [ 0.765, 0.60 ], [ 0.765, 1.0 ], [ 0.32, 1.0 ] ] );

			} else {

				d.rect( 1, 0.035, 0.135, 0.22, 0.575 );
				d.rect( 1, 0.776, 0.135, 0.958, 0.58 );
				d.poly( 0, [ [ 0.135, 0.20 ], [ 0.235, 0.43 ], [ 0.235, 0.48 ], [ 0.02, 0.50 ], [ 0.02, 0.33 ] ] ); // the mountain
				d.rect( 0, 0.11, 0.13, 0.135, 0.585 );               // glazing bars stay put
				d.rect( 0, 0.03, 0.332, 0.224, 0.373 );
				d.rect( 0, 0.855, 0.13, 0.879, 0.59 );
				d.rect( 0, 0.772, 0.332, 0.962, 0.373 );

			}

		}
	},
	portrait: {
		path: PATH + 'portrait/',
		aspect: 941 / 1672,
		hang: [ 0.45, 0.78 ],
		horizon: 0.40,
		hotspots: {
			shelf: {
				poly: [
					[ 0.201, 0.334 ], [ 0.219, 0.33 ], [ 0.233, 0.303 ], [ 0.255, 0.291 ], [ 0.294, 0.292 ], [ 0.327, 0.308 ],
					[ 0.341, 0.294 ], [ 0.373, 0.289 ], [ 0.411, 0.299 ], [ 0.422, 0.321 ], [ 0.432, 0.303 ], [ 0.443, 0.285 ],
					[ 0.459, 0.276 ], [ 0.5, 0.278 ], [ 0.519, 0.287 ], [ 0.528, 0.31 ], [ 0.535, 0.303 ], [ 0.548, 0.292 ],
					[ 0.599, 0.29 ], [ 0.623, 0.299 ], [ 0.627, 0.317 ], [ 0.634, 0.303 ], [ 0.647, 0.288 ], [ 0.655, 0.276 ],
					[ 0.672, 0.27 ], [ 0.694, 0.28 ], [ 0.697, 0.288 ], [ 0.707, 0.292 ], [ 0.723, 0.285 ], [ 0.745, 0.286 ],
					[ 0.771, 0.301 ], [ 0.782, 0.321 ], [ 0.806, 0.333 ], [ 0.806, 0.347 ], [ 0.742, 0.351 ], [ 0.74, 0.389 ],
					[ 0.712, 0.389 ], [ 0.713, 0.351 ], [ 0.3, 0.351 ], [ 0.297, 0.389 ], [ 0.28, 0.389 ], [ 0.269, 0.351 ],
					[ 0.203, 0.348 ]
				],
				centre: [ 0.5, 0.32 ],
				anchor: [ 0.5, 0.272 ],
				side: 'above',
				lead: 0.085
			},
			rack: {
				poly: [
					[ 0.189, 0.392 ], [ 0.213, 0.389 ], [ 0.224, 0.418 ], [ 0.758, 0.418 ], [ 0.758, 0.405 ], [ 0.787, 0.404 ],
					[ 0.788, 0.482 ], [ 0.794, 0.488 ], [ 0.82, 0.511 ], [ 0.849, 0.564 ], [ 0.874, 0.625 ], [ 0.886, 0.666 ],
					[ 0.882, 0.728 ], [ 0.867, 0.76 ], [ 0.833, 0.764 ], [ 0.835, 0.798 ], [ 0.794, 0.799 ], [ 0.791, 0.784 ],
					[ 0.256, 0.784 ], [ 0.256, 0.798 ], [ 0.215, 0.799 ], [ 0.22, 0.748 ], [ 0.224, 0.642 ], [ 0.192, 0.61 ],
					[ 0.186, 0.603 ], [ 0.198, 0.601 ], [ 0.222, 0.618 ], [ 0.214, 0.511 ], [ 0.209, 0.482 ]
				],
				centre: [ 0.52, 0.6 ],
				anchor: [ 0.5, 0.8 ],
				side: 'below'
			}
		},
		paint( d, layer ) {

			if ( layer === 'depth' ) {

				d.rect( 0.35, 0, 0, 1, 1 );                          // the back wall
				d.rect( 0.45, 0, 0.2, 0.178, 0.51 );                 // left window, frame and sill
				d.rect( 0.45, 0.825, 0.2, 1, 0.51 );                 // right window
				d.rect( 0.0, 0, 0.232, 0.137, 0.491 );               // the view out of them
				d.rect( 0.0, 0.873, 0.232, 1, 0.491 );
				d.rect( 0.45, 0, 0.359, 0.137, 0.371 );              // their glazing bars
				d.rect( 0.45, 0.873, 0.359, 1, 0.371 );
				d.rect( 0.44, 0.24, 0.18, 0.776, 0.25 );             // the rifle
				d.poly( 0.55, this.hotspots.shelf.poly );            // shelf and hats
				d.floor( 0.745, [ [ 0, 1 ] ] );                       // the floor, nearer lower down
				d.poly( 0.85, this.hotspots.rack.poly );             // rack and coats

			} else if ( layer === 'cloth' ) {

				d.poly( 1, [ [ 0.23, 0.47 ], [ 0.79, 0.47 ], [ 0.85, 0.56 ], [ 0.885, 0.67 ], [ 0.87, 0.76 ], [ 0.24, 0.76 ] ] );

			} else {

				d.rect( 1, 0, 0.232, 0.137, 0.491 );
				d.rect( 1, 0.873, 0.232, 1, 0.491 );
				d.poly( 0, [ [ 0, 0.27 ], [ 0.03, 0.285 ], [ 0.137, 0.40 ], [ 0.137, 0.445 ], [ 0, 0.455 ] ] ); // the mountain
				d.rect( 0, 0, 0.357, 0.137, 0.373 );                 // glazing bars stay put
				d.rect( 0, 0.873, 0.357, 1, 0.373 );

			}

		}
	}
};
const HOTSPOT_IDS = [ 'shelf', 'rack' ];

const inside = ( [ x, y ], poly ) => {

	let hit = false;
	for ( let i = 0, j = poly.length - 1; i < poly.length; j = i ++ ) {

		const [ xi, yi ] = poly[ i ];
		const [ xj, yj ] = poly[ j ];
		if ( ( yi > y ) !== ( yj > y ) && x < ( xj - xi ) * ( y - yi ) / ( yj - yi ) + xi ) hit = ! hit;

	}

	return hit;

};

const clamp = ( x, a, b ) => Math.min( b, Math.max( a, x ) );
const smoothstep = ( a, b, x ) => {

	const t = clamp( ( x - a ) / ( b - a ), 0, 1 );
	return t * t * ( 3 - 2 * t );

};

/**
 * A set's depth and the parts that move, drawn by hand over its painting: r is depth (1
 * nearest), g the cloth on the rack, b the view out of the windows with the mountain left out
 * — it must not shimmer like sky. Blurred, so the parallax bends rather than tears at the
 * edges. A second texture holds the hotspots, only just softened: r the shelf, g the rack.
 */
function paintMask( set ) {

	const long = 1024;
	const width = set.aspect >= 1 ? long : Math.round( long * set.aspect );
	const height = set.aspect >= 1 ? Math.round( long / set.aspect ) : long;

	const grey = v => `rgb(${ v * 255 | 0 },${ v * 255 | 0 },${ v * 255 | 0 })`;
	const on = c => ( {
		rect: ( v, x0, y0, x1, y1 ) => {

			c.fillStyle = grey( v );
			c.fillRect( x0 * width, y0 * height, ( x1 - x0 ) * width, ( y1 - y0 ) * height );

		},
		poly: ( v, points ) => {

			c.fillStyle = grey( v );
			c.beginPath();
			points.forEach( ( [ x, y ], i ) => i ? c.lineTo( x * width, y * height ) : c.moveTo( x * width, y * height ) );
			c.closePath();
			c.fill();

		},
		// from row y0 to the bottom, ramping from the wall's depth to nearest, over column spans
		floor: ( y0, spans ) => {

			const g = c.createLinearGradient( 0, y0 * height, 0, height );
			g.addColorStop( 0, grey( 0.35 ) );
			g.addColorStop( 1, grey( 1 ) );
			c.fillStyle = g;
			spans.forEach( ( [ x0, x1 ] ) => c.fillRect( x0 * width, y0 * height, ( x1 - x0 ) * width, ( 1 - y0 ) * height ) );

		}
	} );

	// Each channel is painted greyscale on its own canvas, blurred, then packed.
	const paint = ( draw, blur ) => {

		const layer = document.createElement( 'canvas' );
		layer.width = width;
		layer.height = height;
		const c = layer.getContext( '2d' );
		c.fillStyle = '#000';
		c.fillRect( 0, 0, width, height );
		draw( on( c ) );
		const out = document.createElement( 'canvas' );
		out.width = width;
		out.height = height;
		const o = out.getContext( '2d' );
		o.filter = `blur(${ blur }px)`;
		o.drawImage( layer, 0, 0 );
		return o.getImageData( 0, 0, width, height ).data;

	};

	const blur = width / 100;
	const depth = paint( d => set.paint( d, 'depth' ), blur );
	const cloth = paint( d => set.paint( d, 'cloth' ), blur * 1.2 );
	const view = paint( d => set.paint( d, 'view' ), blur * 0.4 );
	const spot = id => paint( d => d.poly( 1, set.hotspots[ id ].poly ), width / 500 );

	return {
		mask: pack( width, height, [ depth, cloth, view ] ),
		hot: pack( width, height, [ spot( 'shelf' ), spot( 'rack' ), null ] )
	};

}

/** Greyscale layers into one texture's channels, flipped: rows were painted top-down. */
function pack( width, height, layers ) {

	const data = new Uint8Array( width * height * 4 );
	for ( let i = 0; i < width * height; i ++ ) {

		for ( let c = 0; c < 3; c ++ ) data[ i * 4 + c ] = layers[ c ] ? layers[ c ][ i * 4 ] : 0;
		data[ i * 4 + 3 ] = 255;

	}

	const flipped = new Uint8Array( data.length );
	const row = width * 4;
	for ( let y = 0; y < height; y ++ ) flipped.set( data.subarray( y * row, ( y + 1 ) * row ), ( height - 1 - y ) * row );

	const texture = new THREE.DataTexture( flipped, width, height, THREE.RGBAFormat );
	texture.minFilter = THREE.LinearFilter;
	texture.magFilter = THREE.LinearFilter;
	texture.needsUpdate = true;
	return texture;

}

export class Interior {

	constructor() {

		// the sets loaded so far ({ textures, mask, hot }), and the one showing
		this.sets = {};
		this._loads = {};
		this.setName = null;
		this.set = null;
		this._want = 'landscape';
		this._loadTexture = null;
		this.ready = false;

		this.time = 0;
		this.wash = 0;
		this.gust = 0;
		this.zoom = BASE_ZOOM;
		this.weights = new THREE.Vector3( 1, 0, 0 );

		this.pointer = new THREE.Vector2();
		this.hasPointer = false;
		// a phone's tilt stands in for the pointer, −1..1 like it
		this.tilt = new THREE.Vector2();
		this.hasTilt = false;
		this.pan = 0;
		this._panTarget = 0;

		// The hotspot under the pointer, each one's eased hover, and the press flash.
		this.hover = null;
		this._hot = new THREE.Vector2();
		this._press = new THREE.Vector2();
		this._sweepTime = 10;
		this._glint = 0;

		this.material = new THREE.RawShaderMaterial( {
			uniforms: {
				u_day: { value: null },
				u_sunset: { value: null },
				u_night: { value: null },
				u_mask: { value: null },
				u_hotMask: { value: null },
				u_hot: { value: this._hot },
				u_press: { value: this._press },
				u_hotCentre: { value: [ new THREE.Vector2(), new THREE.Vector2() ] },
				u_sweep: { value: 10 },
				u_glint: { value: 0 },
				u_weights: { value: this.weights },
				u_resolution: { value: new THREE.Vector2( 1, 1 ) },
				u_imageAspect: { value: 1672 / 941 },
				u_time: { value: 0 },
				u_parallax: { value: new THREE.Vector2() },
				u_focus: { value: new THREE.Vector2( 0.5, 0.5 ) },
				u_zoom: { value: BASE_ZOOM },
				u_wash: { value: 0 },
				u_gust: { value: 0 },
				u_hang: { value: new THREE.Vector2( 0.47, 1 ) },
				u_horizon: { value: 0.45 }
			},
			vertexShader: FboHelper.PRECISION_PREFIX + quadVert,
			fragmentShader: FboHelper.PRECISION_PREFIX + interiorFrag,
			blending: THREE.NoBlending,
			depthTest: false,
			depthWrite: false
		} );

	}

	/**
	 * Starts the paintings for the screen's shape downloading; resolves once that set is in
	 * and showing. Safe to call again.
	 */
	preload( loadTexture ) {

		this._loadTexture = loadTexture;
		return this._load( this._want );

	}

	_load( name ) {

		if ( this._loads[ name ] ) return this._loads[ name ];

		const set = SETS[ name ];
		this._loads[ name ] = Promise.all( LIGHTS.map( light => this._loadTexture( set.path + light + '.webp' ) ) )
			.then( textures => {

				this.sets[ name ] = { textures, ...paintMask( set ) };
				// show it if it is (still) the one this screen wants, or if nothing is up yet
				if ( this._want === name || ! this.set ) this._use( name );
				return this;

			} );

		return this._loads[ name ];

	}

	_use( name ) {

		const set = SETS[ name ];
		const loaded = this.sets[ name ];
		const u = this.material.uniforms;
		LIGHTS.forEach( ( light, i ) => {

			u[ 'u_' + light ].value = loaded.textures[ i ];

		} );
		u.u_mask.value = loaded.mask;
		u.u_hotMask.value = loaded.hot;
		u.u_imageAspect.value = set.aspect;
		u.u_hang.value.fromArray( set.hang );
		u.u_horizon.value = set.horizon;
		// texture space is y up
		HOTSPOT_IDS.forEach( ( id, i ) => u.u_hotCentre.value[ i ].set( set.hotspots[ id ].centre[ 0 ], 1 - set.hotspots[ id ].centre[ 1 ] ) );

		this.setName = name;
		this.set = set;
		this.ready = true;

	}

	/** Which painting shows, from the sun's height (DayNight.elevation, −1..1). */
	setLight( elevation ) {

		const night = 1 - smoothstep( - 0.16, - 0.02, elevation );
		const day = smoothstep( 0.08, 0.26, elevation );
		this.weights.set( day, Math.max( 0, 1 - day - night ), night );

	}

	/** The screen's size; an upright screen gets the portrait paintings, loaded if need be. */
	setSize( width, height ) {

		this.material.uniforms.u_resolution.value.set( width, height );

		this._want = width < height ? 'portrait' : 'landscape';
		if ( this._want === this.setName ) return;
		if ( this.sets[ this._want ] ) this._use( this._want );
		else if ( this._loadTexture ) this._load( this._want );

	}

	/** The pointer in −1..1, as the canvas reports it. */
	setPointer( x, y ) {

		this.pointer.set( x, y );
		this.hasPointer = true;

	}

	/** How the phone is tilted from where it was held, −1..1 each way. */
	setTilt( x, y ) {

		this.tilt.set( x, y );
		this.hasTilt = true;

	}

	/** A horizontal drag on a narrow screen, in screen widths. */
	dragPan( dx ) {

		this._panTarget = clamp( this._panTarget - dx * 0.6, - PAN_RANGE, PAN_RANGE );

	}

	/** The crop the shader shows: how much of the picture spans the screen, and its middle. */
	_crop() {

		const u = this.material.uniforms;
		const resolution = u.u_resolution.value;
		const screenAspect = resolution.x / resolution.y;
		const imageAspect = u.u_imageAspect.value;
		const sx = ( screenAspect > imageAspect ? 1 : screenAspect / imageAspect ) / this.zoom;
		const sy = ( screenAspect > imageAspect ? imageAspect / screenAspect : 1 ) / this.zoom;
		const focus = u.u_focus.value;
		return {
			sx, sy,
			fx: clamp( focus.x, sx / 2, 1 - sx / 2 ),
			fy: clamp( focus.y, sy / 2, 1 - sy / 2 )
		};

	}

	/** A screen point (0..1, y down) to the painting's coordinates (0..1, y down). */
	toImage( x, y ) {

		const { sx, sy, fx, fy } = this._crop();
		return [ fx + ( x - 0.5 ) * sx, 1 - ( fy + ( 0.5 - y ) * sy ) ];

	}

	/** The painting's coordinates to a screen point (0..1, y down). */
	toScreen( x, y ) {

		const { sx, sy, fx, fy } = this._crop();
		return [ ( x - fx ) / sx + 0.5, 0.5 - ( 1 - y - fy ) / sy ];

	}

	/** Which hotspot, if any, is under a screen point (0..1, y down). */
	pick( x, y ) {

		if ( ! this.set ) return null;
		const point = this.toImage( x, y );
		return HOTSPOT_IDS.find( id => inside( point, this.set.hotspots[ id ].poly ) ) || null;

	}

	setHover( id ) {

		if ( id === this.hover ) return;
		this.hover = id;
		// the light runs across it once each time the pointer arrives
		if ( id ) this._sweepTime = 0;

	}

	/** A click or tap on a hotspot: it flashes. */
	press( id ) {

		const i = HOTSPOT_IDS.indexOf( id );
		if ( i < 0 ) return;
		this._press.setComponent( i, 1 );
		this._sweepTime = 0;

	}

	/**
	 * A glint run across a hotspot, bigger than the hover's, to show it can be touched: lit
	 * as if hovered, with a bright band crossing it. setHover( null ) lets it go.
	 */
	glint( id ) {

		this.setHover( id );
		this._sweepTime = 0;
		this._glint = 1;

	}

	/** Where a hotspot's label hangs on screen (0..1, y down), and which side it reads to. */
	anchor( id ) {

		const spot = this.set.hotspots[ id ];
		const [ x, y ] = this.toScreen( spot.anchor[ 0 ], spot.anchor[ 1 ] );
		return { x, y, side: spot.side, lead: spot.lead };

	}

	update( dt ) {

		this.time += dt;
		const t = this.time;
		const u = this.material.uniforms;

		// The eye: the pointer where there is one, else the phone's tilt, plus a slow figure of
		// its own — smaller under a tilting hand, which keeps it moving anyway.
		const eye = this.hasPointer ? this.pointer : this.hasTilt ? this.tilt : null;
		const drift = this.hasTilt && ! this.hasPointer ? DRIFT * 0.35 : DRIFT;
		const tx = ( eye ? eye.x : 0 ) + Math.sin( t * 0.21 ) * drift;
		const ty = ( eye ? eye.y : 0 ) * 0.6 + Math.sin( t * 0.17 + 1.1 ) * drift * 0.6;
		// a tilt is followed more closely than a mouse, so the room feels held in the hand
		const ease = 1 - Math.exp( - dt * ( eye === this.tilt ? PARALLAX_EASE * 1.6 : PARALLAX_EASE ) );
		u.u_parallax.value.x += ( tx - u.u_parallax.value.x ) * ease;
		u.u_parallax.value.y += ( ty - u.u_parallax.value.y ) * ease;

		// A narrow screen pans: dragged, it follows the finger; let go, it drifts back.
		this._panTarget *= Math.exp( - dt * 0.15 );
		this.pan += ( this._panTarget - this.pan ) * ( 1 - Math.exp( - dt * 4 ) );

		const resolution = u.u_resolution.value;
		const screenAspect = resolution.x / resolution.y;
		const span = Math.min( 1, screenAspect / u.u_imageAspect.value ) / this.zoom;
		// the slice wanders over the rack by itself on a phone
		const wander = ( 1 - span ) * 0.22 * Math.sin( t * 0.06 );
		u.u_focus.value.set( 0.5 + wander + this.pan * ( 1 - span ) * 0.5, 0.52 );

		// hover eases in and out; the press flash falls away; the sweep runs once
		const hoverEase = 1 - Math.exp( - dt * 7 );
		HOTSPOT_IDS.forEach( ( id, i ) => {

			const target = this.hover === id ? 1 : 0;
			this._hot.setComponent( i, this._hot.getComponent( i ) + ( target - this._hot.getComponent( i ) ) * hoverEase );
			this._press.setComponent( i, this._press.getComponent( i ) * Math.exp( - dt * 3.5 ) );

		} );
		this._sweepTime += dt;
		u.u_sweep.value = this._sweepTime / ( this._glint > 0 ? 1.3 : 1.1 );
		this._glint = Math.max( 0, this._glint - dt / 1.8 );
		u.u_glint.value = this._glint;

		u.u_time.value = t;
		u.u_zoom.value = this.zoom;
		u.u_wash.value = this.wash;
		u.u_gust.value = this.gust;

	}

	render( renderer, target = null ) {

		FboHelper.render( renderer, this.material, target );

	}

}

export { BASE_ZOOM, SETS };
