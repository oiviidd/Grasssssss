/**
 * The original ships four baked maps painted for *its* terrain. Three of them encode
 * the river — the grass albedo literally has the channel stained into it, and the AO
 * / rock masks follow the riverbed — so on a river-less hill they have to be
 * regenerated rather than reused.
 *
 * Everything here is baked once, on the CPU, from the height raster produced by
 * TerrainSurface.rasterize(). That means it works identically for the procedural hill
 * and for a mesh sculpted in Blender.
 *
 * The grass palette is measured from the original grass.jpg (river region excluded):
 *   shadow #182600 · mid #293e02 · light #3c5a0c
 * It is deliberately this dark — the render happens with no gamma conversion and the
 * final grade's colour-dodge tint is what lifts it into daylight.
 */
import * as THREE from '../vendor/three.module.js';
import { fbm } from './HillGeometry.js';

/**
 * Started from the original grass.jpg's own percentiles (river region excluded), then
 * fitted so the *rendered* result matches Reference/photo_*.jpg rather than matching the
 * source texture — green ×1.6, red ×0.8.
 *
 * The correction is needed because the original's map was painted against its own AO
 * bake and terrain, and because the grade is not a neutral operator: the colour-dodge
 * tint divides red by (1 - 0.447) but green by (1 - 0.706), so it compresses red far
 * less than green. Feeding it the source palette verbatim rendered ~20 too red and ~20
 * too dark in green. Measured over the grass region, this lands within 9 (summed RGB) of
 * the reference, versus 43 before.
 */
const GRASS_SHADOW = [ 0.075, 0.238, 0.0 ];
const GRASS_MID    = [ 0.129, 0.389, 0.013 ];
const GRASS_LIGHT  = [ 0.188, 0.565, 0.075 ];

function mixRGB( a, b, t, out, offset, scale = 1 ) {

	out[ offset ]     = ( a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t ) * scale * 255;
	out[ offset + 1 ] = ( a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t ) * scale * 255;
	out[ offset + 2 ] = ( a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t ) * scale * 255;

}

function makeTexture( data, resolution ) {

	const texture = new THREE.DataTexture( data, resolution, resolution, THREE.RGBAFormat );
	texture.minFilter = THREE.LinearMipMapLinearFilter;
	texture.magFilter = THREE.LinearFilter;
	texture.generateMipmaps = true;
	texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
	texture.needsUpdate = true;
	return texture;

}

/**
 * Horizon-angle ambient occlusion straight off the height raster.
 *
 * For each texel we march outward in `directions` compass directions and track the
 * steepest upward slope encountered. Sum those horizon angles and you get how much
 * of the sky the point can see — which is all the terrain shader needs, since its
 * only light source *is* the sky.
 */
function bakeAO( raster, { directions = 8, steps = 10, radius = 0.9 } = {} ) {

	const { heights, resolution, stageSize } = raster;
	const texelWorld = stageSize / resolution;
	const stepPixels = Math.max( 1, ( radius / texelWorld ) / steps );

	const ao = new Float32Array( resolution * resolution );

	const cos = new Float32Array( directions );
	const sin = new Float32Array( directions );
	for ( let d = 0; d < directions; d ++ ) {

		const angle = d / directions * Math.PI * 2;
		cos[ d ] = Math.cos( angle );
		sin[ d ] = Math.sin( angle );

	}

	for ( let j = 0; j < resolution; j ++ ) {

		for ( let i = 0; i < resolution; i ++ ) {

			const k = j * resolution + i;
			const h0 = heights[ k ];
			let openness = 0;

			for ( let d = 0; d < directions; d ++ ) {

				let maxTangent = 0;

				for ( let s = 1; s <= steps; s ++ ) {

					const dist = s * stepPixels;
					const si = Math.round( i + cos[ d ] * dist );
					const sj = Math.round( j + sin[ d ] * dist );

					if ( si < 0 || sj < 0 || si >= resolution || sj >= resolution ) break;

					const dh = heights[ sj * resolution + si ] - h0;
					if ( dh <= 0 ) continue;

					const tangent = dh / ( dist * texelWorld );
					if ( tangent > maxTangent ) maxTangent = tangent;

				}

				// 1 for a clear horizon, →0 when a wall rises next to us
				openness += 1 / Math.sqrt( 1 + maxTangent * maxTangent );

			}

			ao[ k ] = openness / directions;

		}

	}

	return ao;

}

export function bakeTerrainMaps( raster, options = {} ) {

	const { heights, slopes, resolution, stageSize } = raster;
	const count = resolution * resolution;

	const rockSlopeStart = options.rockSlopeStart !== undefined ? options.rockSlopeStart : 0.22;
	const rockSlopeEnd = options.rockSlopeEnd !== undefined ? options.rockSlopeEnd : 0.55;
	const rockEnabled = options.rock !== false;

	const ao = bakeAO( raster, options.ao );

	const colorData = new Uint8Array( count * 4 );
	const infoData = new Uint8Array( count * 4 );
	const aoData = new Uint8Array( count * 4 );

	let minHeight = Infinity, maxHeight = - Infinity;
	for ( let k = 0; k < count; k ++ ) {

		if ( heights[ k ] < minHeight ) minHeight = heights[ k ];
		if ( heights[ k ] > maxHeight ) maxHeight = heights[ k ];

	}
	const heightSpan = Math.max( 1e-6, maxHeight - minHeight );

	for ( let j = 0; j < resolution; j ++ ) {

		const z = ( ( j + 0.5 ) / resolution - 0.5 ) * stageSize;

		for ( let i = 0; i < resolution; i ++ ) {

			const x = ( ( i + 0.5 ) / resolution - 0.5 ) * stageSize;
			const k = j * resolution + i;
			const o = k * 4;

			/* ── rock mask ─────────────────────────────────────────────────────── */
			let rock = 0;
			if ( rockEnabled ) {

				rock = THREE.MathUtils.smoothstep( slopes[ k ], rockSlopeStart, rockSlopeEnd );
				// break up the slope threshold so the transition is not a clean contour
				rock = THREE.MathUtils.clamp( rock + fbm( x * 1.1 + 31.7, z * 1.1 - 5.2, 3 ) * 0.22, 0, 1 );
				rock *= rock;

			}

			infoData[ o ] = 0;
			infoData[ o + 1 ] = 0;
			infoData[ o + 2 ] = 0;
			infoData[ o + 3 ] = rock * 255;

			/* ── grass albedo ──────────────────────────────────────────────────── */
			// two noise octaves at different scales: broad patches of lighter/darker
			// grass, plus fine mottling
			const patch = fbm( x * 0.33, z * 0.33, 4 ) * 0.5 + 0.5;
			const mottle = fbm( x * 2.6 - 19.4, z * 2.6 + 3.8, 3 ) * 0.5 + 0.5;
			const relativeHeight = ( heights[ k ] - minHeight ) / heightSpan;

			// crowns catch light, hollows stay in shadow
			let t = patch * 0.55 + mottle * 0.2 + relativeHeight * 0.25;
			t = THREE.MathUtils.clamp( t, 0, 1 );

			if ( t < 0.5 ) {

				mixRGB( GRASS_SHADOW, GRASS_MID, t * 2, colorData, o );

			} else {

				mixRGB( GRASS_MID, GRASS_LIGHT, ( t - 0.5 ) * 2, colorData, o );

			}

			// let the baked AO tint the albedo too, the way a painted map would — but
			// gently: the terrain shader already multiplies by the AO map separately, so
			// a heavy hand here darkens twice
			const shade = 0.78 + 0.22 * ao[ k ];
			colorData[ o ] *= shade;
			colorData[ o + 1 ] *= shade;
			colorData[ o + 2 ] *= shade;
			colorData[ o + 3 ] = 255;

			/* ── AO ────────────────────────────────────────────────────────────── */
			// .r is the contact-shadow channel the shader fades by rockiness,
			// .g is a flat multiplier — same split the original's map uses
			const contact = THREE.MathUtils.clamp( Math.pow( ao[ k ], 1.6 ), 0, 1 );
			const broad = THREE.MathUtils.clamp( 0.72 + 0.28 * ao[ k ], 0, 1 );

			aoData[ o ] = contact * 255;
			aoData[ o + 1 ] = broad * 255;
			aoData[ o + 2 ] = 0;
			aoData[ o + 3 ] = 255;

		}

	}

	return {
		grassTexture: makeTexture( colorData, resolution ),
		infoTexture: makeTexture( infoData, resolution ),
		aoTexture: makeTexture( aoData, resolution ),
		ao
	};

}
