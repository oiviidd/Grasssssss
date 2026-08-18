/**
 * Measures the live render with exactly the same maths tools/measure_reference.py applies
 * to a reference photograph, so the two are directly comparable.
 *
 * Dev-only: loaded on demand by `window.grassStudy.measure()`, never on the render path.
 *
 * Matching the resolution matters more than it looks. Edge frequency counts luminance
 * sign changes per unit of frame width, so a lower-resolution image blurs neighbouring
 * blades together and reports *fewer* edges for identical geometry. Comparing a
 * 1024-wide render against an 818-wide photograph silently biases the result, which is
 * why this renders at whatever size the reference was.
 */
import * as THREE from '../vendor/three.module.js';

function median( values ) {

	if ( ! values.length ) return null;
	const sorted = values.slice().sort( ( a, b ) => a - b );
	return sorted[ Math.floor( sorted.length / 2 ) ];

}

function percentile( sorted, q ) {

	return sorted[ Math.min( sorted.length - 1, Math.floor( q * sorted.length ) ) ];

}

/**
 * Runs the full pipeline into an offscreen target and reads it back.
 *
 * The default framebuffer cannot be sampled — the canvas has no preserveDrawingBuffer and
 * the compositor has already swapped by the time any readback runs — so the scene, bloom
 * and grade are re-run into targets owned here.
 */
export function measureRender( context, width, height, excludeX = [] ) {

	const { renderer, scene, camera, bloom, grade } = context;

	const options = {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
		type: THREE.UnsignedByteType,
		stencilBuffer: false
	};

	const sceneTarget = new THREE.WebGLRenderTarget( width, height, options );
	const bloomTarget = new THREE.WebGLRenderTarget( width, height, options );
	const finalTarget = new THREE.WebGLRenderTarget( width, height, options );

	const shotCamera = camera.clone();
	shotCamera.aspect = width / height;
	shotCamera.updateProjectionMatrix();
	shotCamera.position.copy( camera.position );
	shotCamera.quaternion.copy( camera.quaternion );
	shotCamera.updateMatrixWorld();

	const previousWidth = renderer.domElement.width;
	const previousHeight = renderer.domElement.height;

	bloom.setSize( width, height );

	renderer.setRenderTarget( sceneTarget );
	renderer.clear( true, true, true );
	renderer.render( scene, shotCamera );
	bloom.render( renderer, sceneTarget.texture, bloomTarget );
	grade.render( renderer, bloomTarget.texture, width, height, finalTarget );

	const pixels = new Uint8Array( width * height * 4 );
	renderer.readRenderTargetPixels( finalTarget, 0, 0, width, height, pixels );

	renderer.setRenderTarget( null );
	bloom.setSize( previousWidth, previousHeight );

	sceneTarget.dispose();
	bloomTarget.dispose();
	finalTarget.dispose();

	/* readPixels is bottom-up; every helper below works in top-down frame rows */
	const at = ( x, yTop ) => ( ( height - 1 - yTop ) * width + x ) * 4;
	const included = x => ! excludeX.some( ( [ lo, hi ] ) => x / width >= lo && x / width <= hi );
	const isGrass = o => pixels[ o + 1 ] - pixels[ o + 2 ] > 5;   // green beats blue

	/* ── skyline: solid (landform) and raw (blade tips) ────────────────────────── */

	const solid = new Array( width ).fill( NaN );
	const raw = new Array( width ).fill( NaN );

	for ( let x = 0; x < width; x ++ ) {

		if ( ! included( x ) ) continue;

		for ( let y = 0; y < height; y ++ ) {

			if ( ! isGrass( at( x, y ) ) ) continue;

			if ( isNaN( raw[ x ] ) ) raw[ x ] = y;

			// require the run to persist, so drifting insects are not landform
			let run = 0;
			for ( let k = 0; k < 18 && y + k < height; k ++ ) if ( isGrass( at( x, y + k ) ) ) run ++;
			if ( run / Math.min( 18, height - y ) > 0.85 ) { solid[ x ] = y; break; }

		}

	}

	const COLUMNS = 21;
	const skyline = [];
	for ( let i = 0; i < COLUMNS; i ++ ) {

		const x = Math.min( width - 1, Math.round( i / ( COLUMNS - 1 ) * width ) );
		skyline.push( included( x ) && ! isNaN( solid[ x ] ) ? + ( solid[ x ] / height ).toFixed( 4 ) : null );

	}

	/* ── raggedness: detrended blade-tip variation ─────────────────────────────── */

	const tips = raw.filter( v => ! isNaN( v ) );
	let raggedness = null;

	if ( tips.length > 81 ) {

		const residual = [];
		for ( let i = 0; i < tips.length; i ++ ) {

			const window = tips.slice( Math.max( 0, i - 40 ), Math.min( tips.length, i + 41 ) )
				.sort( ( a, b ) => a - b );
			residual.push( tips[ i ] - window[ Math.floor( window.length / 2 ) ] );

		}

		const mean = residual.reduce( ( a, b ) => a + b, 0 ) / residual.length;
		const variance = residual.reduce( ( a, b ) => a + ( b - mean ) ** 2, 0 ) / residual.length;
		const sorted = residual.slice().sort( ( a, b ) => a - b );

		raggedness = {
			std: + ( Math.sqrt( variance ) / height ).toFixed( 5 ),
			p90p10: + ( ( percentile( sorted, 0.9 ) - percentile( sorted, 0.1 ) ) / height ).toFixed( 5 )
		};

	}

	/* ── edge frequency: proxy for blade width ─────────────────────────────────── */

	const band = ( y0, y1 ) => {

		const counts = [];

		for ( let s = 0; s < 25; s ++ ) {

			const y = Math.min( height - 1, Math.round( ( y0 + ( y1 - y0 ) * s / 24 ) * height ) );
			let previousSign = 0, changes = 0, samples = 0, previousLuma = null;

			for ( let x = 0; x < width; x ++ ) {

				if ( ! included( x ) ) continue;
				const o = at( x, y );
				const luma = ( pixels[ o ] + pixels[ o + 1 ] + pixels[ o + 2 ] ) / 765;

				if ( previousLuma !== null ) {

					let d = luma - previousLuma;
					if ( Math.abs( d ) < 0.004 ) d = 0;         // ignore compression noise
					const sign = Math.sign( d );
					if ( sign !== 0 ) {

						if ( previousSign !== 0 && sign !== previousSign ) changes ++;
						previousSign = sign;

					}

				}

				previousLuma = luma;
				samples ++;

			}

			if ( samples > 2 ) counts.push( changes / samples );

		}

		const m = median( counts );
		return m === null ? null : + m.toFixed( 4 );

	};

	/* ── palette ───────────────────────────────────────────────────────────────── */

	const grass = [];
	for ( let y = Math.round( 0.55 * height ); y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			if ( ! included( x ) ) continue;
			const o = at( x, y );
			if ( isGrass( o ) ) grass.push( [ pixels[ o ], pixels[ o + 1 ], pixels[ o + 2 ] ] );

		}

	}

	const channel = c => grass.map( p => p[ c ] ).sort( ( a, b ) => a - b );
	const mean = c => Math.round( grass.reduce( ( a, p ) => a + p[ c ], 0 ) / grass.length );

	const palette = grass.length ? {
		mean: [ mean( 0 ), mean( 1 ), mean( 2 ) ],
		p05: [ 0, 1, 2 ].map( c => percentile( channel( c ), 0.05 ) ),
		p50: [ 0, 1, 2 ].map( c => percentile( channel( c ), 0.50 ) ),
		p95: [ 0, 1, 2 ].map( c => percentile( channel( c ), 0.95 ) ),
		greenMinusBlue: + ( mean( 1 ) - mean( 2 ) ).toFixed( 1 )
	} : null;

	return {
		size: [ width, height ],
		aspect: + ( width / height ).toFixed( 3 ),
		excludeX,
		skyline,
		raggedness,
		edgeFrequency: { upper: band( 0.58, 0.70 ), mid: band( 0.70, 0.85 ), lower: band( 0.85, 0.98 ) },
		palette
	};

}

/** Side-by-side against a reference-metrics.json payload. */
export function compare( mine, reference ) {

    const rows = [];

    const skylineError = ( () => {

        let sum = 0, n = 0;
        for ( let i = 0; i < mine.skyline.length; i ++ ) {

            if ( mine.skyline[ i ] === null || reference.skyline[ i ] === null ) continue;
            sum += Math.abs( mine.skyline[ i ] - reference.skyline[ i ] );
            n ++;

        }
        return n ? + ( sum / n ).toFixed( 4 ) : null;

    } )();

    rows.push( { metric: 'skyline meanErr', mine: skylineError, reference: 0, target: '→ 0' } );

    for ( const key of [ 'upper', 'mid', 'lower' ] ) {

        rows.push( {
            metric: 'edgeFreq ' + key,
            mine: mine.edgeFrequency[ key ],
            reference: reference.edgeFrequency[ key ],
            target: 'match'
        } );

    }

    rows.push( {
        metric: 'raggedness std',
        mine: mine.raggedness && mine.raggedness.std,
        reference: reference.raggedness && reference.raggedness.std,
        target: 'match'
    } );

    rows.push( {
        metric: 'palette mean',
        mine: mine.palette && mine.palette.mean.join( ',' ),
        reference: reference.palette && reference.palette.mean.join( ',' ),
        target: 'match'
    } );

    return rows;

}
