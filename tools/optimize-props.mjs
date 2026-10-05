/**
 * Slims an artist's prop hand-off (the cabin, the mountain) and lays it out to load fast,
 * without changing a pixel of the shot — or as near as measurement can tell.
 *
 *   node tools/optimize-props.mjs <in.glb> <out.glb> '{"meshName": error, …}'
 *
 * What it does, and why each step is safe:
 *
 *   1. Drops the JPEG fallback images. Blender writes every texture twice when it exports
 *      WebP — once as WebP, once as JPEG for viewers without it. GLTFLoader uses the WebP
 *      wherever the browser supports it, which is every browser this site runs in, so the
 *      JPEG was never shown. It was 4.9 MB across the two props.
 *
 *   2. Simplifies the meshes named in the error map, and only those. The simplifier counts
 *      UVs and normals toward its error, not just positions: position-only simplification
 *      lets the baked texture slide across the merged triangles, which showed as hundreds
 *      of shifted pixels on the cabin. error is a fraction of the mesh's size; 0.0001 is
 *      a tenth of a millimetre on the cabin. Meshes left out are untouched.
 *
 *   3. Caps textures at 4096. The mountain's was 8192: four times the decode and the upload
 *      of a 4K map, a quarter of a gigabyte of video memory, and — rendered side by side —
 *      not one pixel of the shot more than 8/255 different at 4K.
 *
 *   4. Splits any mesh over SPLIT_ABOVE triangles into slabs of about SPLIT_SIZE. Draco
 *      decodes one mesh on one worker, so the cabin's million-triangle body took a second
 *      and a half on a single core; in four slabs on four workers, under half a second.
 *      The slabs are separate parts at runtime; markDetails (src/Cabin.js) knows parts in
 *      the building's own paint are all building.
 *
 *   5. Re-encodes with Draco, every mesh on one quantisation grid for the whole file
 *      (16-bit positions), so the edges two slabs share land on exactly the same points —
 *      per-mesh grids would leave hairline cracks along the cuts. Node transforms are baked
 *      into the vertices first so that one grid fits everything; the importer bakes them
 *      in anyway. Maximum compression: smaller than Blender's default and no slower to decode.
 *
 * Measured on the 2026-10 hand-offs, rendering the hero shot before and after:
 *   cabin    8.36 MB → about 4.5 MB  emblem 1M → 258k triangles, the building untouched but
 *                                    in four slabs
 *   mountain 6.21 MB → about 2.0 MB  1M → 574k triangles in three slabs, texture 8K → 4K
 *   together they decode in about 1.0 s instead of 2.2 s, and fewer than 40 pixels of
 *   about 600,000 differ by more than 8/255 from the originals' render.
 * The originals are kept in Reference/models-original/.
 *
 * Needs, once, in this folder:
 *   npm i --no-save @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer draco3dgltf sharp
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { prune, weld, compactPrimitive, clearNodeTransform } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { statSync } from 'fs';

const [ input, output, errorsArg = '{}' ] = process.argv.slice( 2 );

if ( ! input || ! output ) {

	console.log( 'usage: node tools/optimize-props.mjs <in.glb> <out.glb> \'{"meshName": 0.0001}\'' );
	process.exit( 1 );

}

const errors = JSON.parse( errorsArg );

// How much a UV or normal difference counts against the error, relative to position. At 1,
// a UV drift of 0.0001 costs as much as a position error of 0.0001 of the mesh's size —
// under half a texel of a 4K map.
const UV_WEIGHT = 1;
const NORMAL_WEIGHT = 0.5;

const MAX_TEXTURE = 4096;
const WEBP_QUALITY = 85;

const SPLIT_ABOVE = 300000;
const SPLIT_SIZE = 250000;

const io = new NodeIO().registerExtensions( ALL_EXTENSIONS ).registerDependencies( {
	'draco3d.decoder': await draco3d.createDecoderModule(),
	'draco3d.encoder': await draco3d.createEncoderModule()
} );

const doc = await io.read( input );
const root = doc.getRoot();

/* 1. fallbacks out ------------------------------------------------------------- */

// Unreferenced textures are the JPEG fallbacks; weld only merges vertices that are already
// identical, so neither changes what is drawn.
await doc.transform( prune(), weld() );

/* 2. simplify ------------------------------------------------------------------ */

await MeshoptSimplifier.ready;

for ( const mesh of root.listMeshes() ) {

	for ( const prim of mesh.listPrimitives() ) {

		const triangles = prim.getIndices().getCount() / 3;
		const error = errors[ mesh.getName() ] || 0;

		if ( ! error ) {

			console.log( `${ mesh.getName() }: untouched, ${ triangles } triangles` );
			continue;

		}

		const position = prim.getAttribute( 'POSITION' ).getArray();
		const uv = prim.getAttribute( 'TEXCOORD_0' ).getArray();
		const normal = prim.getAttribute( 'NORMAL' ).getArray();
		const count = position.length / 3;

		const attributes = new Float32Array( count * 5 );

		for ( let i = 0; i < count; i ++ ) {

			attributes[ i * 5 ] = uv[ i * 2 ];
			attributes[ i * 5 + 1 ] = uv[ i * 2 + 1 ];
			attributes[ i * 5 + 2 ] = normal[ i * 3 ];
			attributes[ i * 5 + 3 ] = normal[ i * 3 + 1 ];
			attributes[ i * 5 + 4 ] = normal[ i * 3 + 2 ];

		}

		const [ indices, reached ] = MeshoptSimplifier.simplifyWithAttributes(
			Uint32Array.from( prim.getIndices().getArray() ), Float32Array.from( position ), 3,
			attributes, 5, [ UV_WEIGHT, UV_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT ],
			null, 0, error, [] );

		prim.getIndices().setArray( indices );
		compactPrimitive( prim );

		console.log( `${ mesh.getName() }: ${ triangles } → ${ indices.length / 3 } triangles (error ${ reached.toExponential( 2 ) })` );

	}

}

/* 3. textures capped ----------------------------------------------------------- */

for ( const texture of root.listTextures() ) {

	const image = texture.getImage();
	const { width, height } = await sharp( image ).metadata();
	if ( Math.max( width, height ) <= MAX_TEXTURE ) continue;

	const scale = MAX_TEXTURE / Math.max( width, height );
	const scaled = await sharp( image )
		.resize( { width: Math.round( width * scale ), height: Math.round( height * scale ), kernel: 'lanczos3' } )
		.webp( { quality: WEBP_QUALITY, effort: 6, smartSubsample: true } )
		.toBuffer();

	texture.setImage( new Uint8Array( scaled ) ).setMimeType( 'image/webp' );
	console.log( `texture ${ width }×${ height } → ${ Math.round( width * scale ) }×${ Math.round( height * scale ) }` );

}

/* 4. big meshes into slabs ----------------------------------------------------- */

for ( const mesh of root.listMeshes() ) {

	for ( const prim of mesh.listPrimitives() ) {

		const index = prim.getIndices().getArray();
		const triangles = index.length / 3;
		if ( triangles <= SPLIT_ABOVE ) continue;

		const pieces = Math.ceil( triangles / SPLIT_SIZE );
		const position = prim.getAttribute( 'POSITION' ).getArray();

		// slabs across the longest side, by triangle centroid, so each is one compact region
		const min = [ Infinity, Infinity, Infinity ];
		const max = [ - Infinity, - Infinity, - Infinity ];

		for ( let i = 0; i < position.length; i += 3 ) {

			for ( let k = 0; k < 3; k ++ ) {

				min[ k ] = Math.min( min[ k ], position[ i + k ] );
				max[ k ] = Math.max( max[ k ], position[ i + k ] );

			}

		}

		const axis = [ 0, 1, 2 ].reduce( ( a, b ) => ( max[ b ] - min[ b ] > max[ a ] - min[ a ] ? b : a ) );
		const along = new Float32Array( triangles );
		const order = new Uint32Array( triangles );

		for ( let t = 0; t < triangles; t ++ ) {

			order[ t ] = t;
			along[ t ] = position[ index[ t * 3 ] * 3 + axis ] + position[ index[ t * 3 + 1 ] * 3 + axis ] + position[ index[ t * 3 + 2 ] * 3 + axis ];

		}

		order.sort( ( a, b ) => along[ a ] - along[ b ] );

		for ( let p = 0; p < pieces; p ++ ) {

			const from = Math.floor( triangles * p / pieces );
			const to = Math.floor( triangles * ( p + 1 ) / pieces );
			const remap = new Map();
			const local = new Uint32Array( ( to - from ) * 3 );
			const used = [];

			for ( let t = from; t < to; t ++ ) {

				for ( let c = 0; c < 3; c ++ ) {

					const v = index[ order[ t ] * 3 + c ];
					let n = remap.get( v );
					if ( n === undefined ) remap.set( v, n = used.push( v ) - 1 );
					local[ ( t - from ) * 3 + c ] = n;

				}

			}

			const piece = doc.createPrimitive().setMaterial( prim.getMaterial() ).setMode( prim.getMode() );

			for ( const semantic of prim.listSemantics() ) {

				const source = prim.getAttribute( semantic );
				const size = source.getElementSize();
				const array = source.getArray();
				const out = new array.constructor( used.length * size );

				for ( let i = 0; i < used.length; i ++ ) {

					for ( let k = 0; k < size; k ++ ) out[ i * size + k ] = array[ used[ i ] * size + k ];

				}

				piece.setAttribute( semantic, doc.createAccessor()
					.setType( source.getType() ).setArray( out ).setNormalized( source.getNormalized() ).setBuffer( source.getBuffer() ) );

			}

			piece.setIndices( doc.createAccessor().setType( 'SCALAR' ).setArray( local ).setBuffer( prim.getIndices().getBuffer() ) );
			mesh.addPrimitive( piece );

		}

		mesh.removePrimitive( prim );
		prim.dispose();

		console.log( `${ mesh.getName() }: split into ${ pieces } slabs` );

	}

}

/* 5. one grid, Draco ----------------------------------------------------------- */

for ( const node of root.listNodes() ) if ( node.getMesh() ) clearNodeTransform( node );

await doc.transform( prune() );

doc.createExtension( KHRDracoMeshCompression ).setRequired( true ).setEncoderOptions( {
	method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
	encodeSpeed: 0,
	decodeSpeed: 0,
	quantizationVolume: 'scene',
	quantizationBits: { POSITION: 16, NORMAL: 10, TEX_COORD: 14 }
} );

await io.write( output, doc );

console.log( `${ input } ${ statSync( input ).size } → ${ output } ${ statSync( output ).size } bytes` );
