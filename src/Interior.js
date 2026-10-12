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
const BASE_ZOOM = 1.04;

// Pointer parallax easing, and the slow drift that keeps a still pointer (or a phone) alive.
const PARALLAX_EASE = 2.5;
const DRIFT = 0.35;

// Portrait screens see a narrow slice of the picture; a drag pans it, and it eases back.
const PAN_RANGE = 0.5;

const clamp = ( x, a, b ) => Math.min( b, Math.max( a, x ) );
const smoothstep = ( a, b, x ) => {

	const t = clamp( ( x - a ) / ( b - a ), 0, 1 );
	return t * t * ( 3 - 2 * t );

};

/**
 * The painting's depth and the parts that move, drawn by hand over it in its own 0..1
 * coordinates (y down): r is depth (1 nearest), g the cloth on the rack, b the view out of the
 * two windows with the mountain left out — it must not shimmer like sky. Blurred, so the
 * parallax bends rather than tears at the edges.
 */
function paintMask( width = 512, height = 288 ) {

	// Each channel is painted greyscale on its own canvas, blurred, then packed.
	const paint = ( draw, blur ) => {

		const layer = document.createElement( 'canvas' );
		layer.width = width;
		layer.height = height;
		const c = layer.getContext( '2d' );
		draw( c );
		const out = document.createElement( 'canvas' );
		out.width = width;
		out.height = height;
		const o = out.getContext( '2d' );
		o.filter = `blur(${ blur }px)`;
		o.drawImage( layer, 0, 0 );
		return o.getImageData( 0, 0, width, height ).data;

	};

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

		}
	} );

	const depth = paint( c => {

		const d = on( c );
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
		d.rect( 0.55, 0.285, 0.19, 0.715, 0.345 );           // shelf and hats
		d.rect( 0.5, 0.335, 0.33, 0.66, 0.41 );              // its brackets
		d.poly( 0.85, [ [ 0.27, 0.40 ], [ 0.33, 0.40 ], [ 0.33, 0.455 ], [ 0.70, 0.455 ], [ 0.70, 0.43 ],
			[ 0.715, 0.43 ], [ 0.715, 0.53 ], [ 0.765, 0.60 ], [ 0.77, 1.0 ], [ 0.27, 1.0 ] ] ); // rack and coats
		const floor = c.createLinearGradient( 0, 0.9 * height, 0, height );
		floor.addColorStop( 0, grey( 0.35 ) );
		floor.addColorStop( 1, grey( 1 ) );
		c.fillStyle = floor;
		c.fillRect( 0, 0.9 * height, 0.27 * width, 0.1 * height );
		c.fillRect( 0.77 * width, 0.9 * height, 0.23 * width, 0.1 * height );

	}, 5 );

	const cloth = paint( c => {

		const d = on( c );
		d.rect( 0, 0, 0, 1, 1 );
		d.poly( 1, [ [ 0.31, 0.50 ], [ 0.70, 0.50 ], [ 0.765, 0.60 ], [ 0.765, 1.0 ], [ 0.32, 1.0 ] ] );

	}, 6 );

	const view = paint( c => {

		const d = on( c );
		d.rect( 0, 0, 0, 1, 1 );
		d.rect( 1, 0.035, 0.135, 0.22, 0.575 );
		d.rect( 1, 0.776, 0.135, 0.958, 0.58 );
		d.poly( 0, [ [ 0.135, 0.20 ], [ 0.235, 0.43 ], [ 0.235, 0.48 ], [ 0.02, 0.50 ], [ 0.02, 0.33 ] ] ); // the mountain
		d.rect( 0, 0.11, 0.13, 0.135, 0.585 );               // glazing bars stay put
		d.rect( 0, 0.03, 0.332, 0.224, 0.373 );
		d.rect( 0, 0.855, 0.13, 0.879, 0.59 );
		d.rect( 0, 0.772, 0.332, 0.962, 0.373 );

	}, 2 );

	const data = new Uint8Array( width * height * 4 );
	for ( let i = 0; i < width * height; i ++ ) {

		data[ i * 4 ] = depth[ i * 4 ];
		data[ i * 4 + 1 ] = cloth[ i * 4 ];
		data[ i * 4 + 2 ] = view[ i * 4 ];
		data[ i * 4 + 3 ] = 255;

	}

	// Rows were painted top-down; textures read bottom-up.
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

		this.textures = {};
		this.ready = false;
		this._loading = null;

		this.time = 0;
		this.wash = 0;
		this.gust = 0;
		this.zoom = BASE_ZOOM;
		this.weights = new THREE.Vector3( 1, 0, 0 );

		this.pointer = new THREE.Vector2();
		this.hasPointer = false;
		this.pan = 0;
		this._panTarget = 0;

		this.material = new THREE.RawShaderMaterial( {
			uniforms: {
				u_day: { value: null },
				u_sunset: { value: null },
				u_night: { value: null },
				u_mask: { value: null },
				u_weights: { value: this.weights },
				u_resolution: { value: new THREE.Vector2( 1, 1 ) },
				u_imageAspect: { value: 1672 / 941 },
				u_time: { value: 0 },
				u_parallax: { value: new THREE.Vector2() },
				u_focus: { value: new THREE.Vector2( 0.5, 0.5 ) },
				u_zoom: { value: BASE_ZOOM },
				u_wash: { value: 0 },
				u_gust: { value: 0 }
			},
			vertexShader: FboHelper.PRECISION_PREFIX + quadVert,
			fragmentShader: FboHelper.PRECISION_PREFIX + interiorFrag,
			blending: THREE.NoBlending,
			depthTest: false,
			depthWrite: false
		} );

	}

	/** Starts the paintings downloading; resolves once all three are in. Safe to call again. */
	preload( loadTexture ) {

		if ( this._loading ) return this._loading;

		this._loading = Promise.all( LIGHTS.map( light => loadTexture( PATH + light + '.webp' ) ) )
			.then( textures => {

				const u = this.material.uniforms;
				LIGHTS.forEach( ( light, i ) => {

					this.textures[ light ] = textures[ i ];
					u[ 'u_' + light ].value = textures[ i ];

				} );

				const image = textures[ 0 ].image;
				if ( image && image.width ) u.u_imageAspect.value = image.width / image.height;
				u.u_mask.value = paintMask();
				this.ready = true;
				return this;

			} );

		return this._loading;

	}

	/** Which painting shows, from the sun's height (DayNight.elevation, −1..1). */
	setLight( elevation ) {

		const night = 1 - smoothstep( - 0.16, - 0.02, elevation );
		const day = smoothstep( 0.08, 0.26, elevation );
		this.weights.set( day, Math.max( 0, 1 - day - night ), night );

	}

	setSize( width, height ) {

		this.material.uniforms.u_resolution.value.set( width, height );

	}

	/** The pointer in −1..1, as the canvas reports it. */
	setPointer( x, y ) {

		this.pointer.set( x, y );
		this.hasPointer = true;

	}

	/** A horizontal drag on a narrow screen, in screen widths. */
	dragPan( dx ) {

		this._panTarget = clamp( this._panTarget - dx * 0.6, - PAN_RANGE, PAN_RANGE );

	}

	update( dt ) {

		this.time += dt;
		const t = this.time;
		const u = this.material.uniforms;

		// The eye: the pointer where there is one, plus a slow figure of its own.
		const drift = DRIFT;
		const tx = ( this.hasPointer ? this.pointer.x : 0 ) + Math.sin( t * 0.21 ) * drift;
		const ty = ( this.hasPointer ? this.pointer.y : 0 ) * 0.6 + Math.sin( t * 0.17 + 1.1 ) * drift * 0.6;
		const ease = 1 - Math.exp( - dt * PARALLAX_EASE );
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

		u.u_time.value = t;
		u.u_zoom.value = this.zoom;
		u.u_wash.value = this.wash;
		u.u_gust.value = this.gust;

	}

	render( renderer, target = null ) {

		FboHelper.render( renderer, this.material, target );

	}

}

export { BASE_ZOOM };
