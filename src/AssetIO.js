/**
 * Asset hand-off for a 3D artist: pick a file, see it in the scene, no reload and no
 * copying anything into the repo.
 *
 * Three things can be swapped — the hill, a single grass blade, and a grass tuft — plus
 * the flower atlas as an image. Each has an export alongside it so the artist can pull
 * the current asset out, open it in Blender, and put it back.
 *
 * The normalisation below is what makes arbitrary artist meshes work. The shaders carry
 * hard assumptions from the original's own assets — a blade runs 0→1 along +Y and uses
 * `position.y` directly as the along-the-blade ratio — and an imported mesh will not
 * satisfy those by luck. Rather than demand the artist model to a spec they cannot see,
 * imports are re-based and re-scaled to it on the way in.
 */
import * as THREE from '../vendor/three.module.js';

/** Opens a file dialog and resolves with the File, or null if dismissed. */
export function pickFile( accept ) {

	return new Promise( resolve => {

		const input = document.createElement( 'input' );
		input.type = 'file';
		input.accept = accept;
		input.style.display = 'none';
		document.body.appendChild( input );

		// There is no reliable "cancel" event for file inputs. `focus` firing on the window
		// again without a change having landed is the usual signal, and a short grace
		// period avoids racing the change event on slower dialogs.
		let settled = false;
		const finish = value => {

			if ( settled ) return;
			settled = true;
			input.remove();
			resolve( value );

		};

		input.addEventListener( 'change', () => finish( input.files[ 0 ] || null ) );
		window.addEventListener( 'focus', () => setTimeout( () => finish( null ), 500 ), { once: true } );

		input.click();

	} );

}

/**
 * Parses a .glb/.gltf into one merged BufferGeometry with world transforms baked.
 *
 * Artists rarely hand over a single clean mesh — there are usually several objects, some
 * parented, sometimes with modifiers left as separate primitives. Everything is flattened
 * and reduced to position + normal, which is all any of these shaders read.
 */
/**
 * One GLTFLoader for every import, with Draco attached.
 *
 * Blender's glTF exporter offers Draco compression, and a file exported with it lists
 * KHR_draco_mesh_compression as *required*: without a decoder the loader refuses it outright,
 * which is what every compressed hand-off hit. The decoder is vendored under vendor/draco/,
 * runs in workers, and is only fetched the first time a compressed file arrives.
 */
let dracoLoader = null;

async function loadGLTF( arrayBuffer ) {

	const [ { GLTFLoader }, { DRACOLoader } ] = await Promise.all( [
		import( '../vendor/GLTFLoader.js' ),
		import( '../vendor/DRACOLoader.js' )
	] );

	if ( ! dracoLoader ) {

		dracoLoader = new DRACOLoader();
		dracoLoader.setDecoderPath( new URL( '../vendor/draco/', import.meta.url ).href );

	}

	const loader = new GLTFLoader();
	loader.setDRACOLoader( dracoLoader );

	return new Promise( ( resolve, reject ) => loader.parse( arrayBuffer, '', resolve, reject ) );

}

/**
 * Every mesh in the file, baked into world space and reduced to the attributes asked for.
 *
 * `keepUV` exists because this used to keep only position and normal. That is right for the
 * hill and the grass, which are painted in code, and it is exactly why a textured mountain or
 * cabin could never import: its UVs were thrown away here, and the prop importers then
 * refused the file for having none.
 */
function collectParts( gltf, { keepUV = false } = {} ) {

	const keep = keepUV ? [ 'position', 'normal', 'uv' ] : [ 'position', 'normal' ];
	const parts = [];

	gltf.scene.updateMatrixWorld( true );

	gltf.scene.traverse( object => {

		if ( ! object.isMesh ) return;

		const geometry = object.geometry.clone();
		geometry.applyMatrix4( object.matrixWorld );

		for ( const name in geometry.attributes ) {

			if ( keep.indexOf( name ) < 0 ) geometry.deleteAttribute( name );

		}

		if ( ! geometry.attributes.normal ) geometry.computeVertexNormals();

		const material = Array.isArray( object.material ) ? object.material[ 0 ] : object.material;
		parts.push( { geometry: toPlainArrays( geometry ), material } );

	} );

	if ( parts.length === 0 ) throw new Error( 'no meshes in that file' );

	// Merging needs every part to carry the same attributes. If only some parts are unwrapped,
	// dropping UVs everywhere is the honest outcome — the importer then says so.
	if ( keepUV && ! parts.every( p => p.geometry.attributes.uv ) ) {

		parts.forEach( p => p.geometry.attributes.uv && p.geometry.deleteAttribute( 'uv' ) );

	}

	return parts;

}

/**
 * Float32 attributes and a Uint32 index on every part.
 *
 * mergeBufferGeometries refuses parts whose attributes differ in array type or `normalized`,
 * and a glTF can legitimately store one object's UVs as quantised shorts and another's as
 * floats. De-quantising on the way in means two objects from the same file always merge.
 */
function toPlainArrays( geometry ) {

	for ( const name in geometry.attributes ) {

		const attribute = geometry.attributes[ name ];
		if ( attribute.array instanceof Float32Array && ! attribute.normalized && ! attribute.isInterleavedBufferAttribute ) continue;

		const { count, itemSize } = attribute;
		const array = new Float32Array( count * itemSize );
		const getters = [ 'getX', 'getY', 'getZ', 'getW' ];

		// r122's getters return the raw stored integer, so normalised data is scaled here.
		const source = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;
		const divisor = attribute.normalized ? normalisedMax( source ) : 1;

		for ( let i = 0; i < count; i ++ ) {

			for ( let k = 0; k < itemSize; k ++ ) {

				const value = attribute[ getters[ k ] ]( i ) / divisor;
				array[ i * itemSize + k ] = attribute.normalized ? Math.max( - 1, value ) : value;

			}

		}

		geometry.setAttribute( name, new THREE.BufferAttribute( array, itemSize ) );

	}

	const index = geometry.getIndex();

	if ( ! index ) {

		const count = geometry.attributes.position.count;
		const indices = new Uint32Array( count );
		for ( let i = 0; i < count; i ++ ) indices[ i ] = i;
		geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );

	} else if ( ! ( index.array instanceof Uint32Array ) ) {

		geometry.setIndex( new THREE.BufferAttribute( Uint32Array.from( index.array ), 1 ) );

	}

	return geometry;

}

function normalisedMax( array ) {

	if ( array instanceof Int8Array ) return 127;
	if ( array instanceof Uint8Array || array instanceof Uint8ClampedArray ) return 255;
	if ( array instanceof Int16Array ) return 32767;
	if ( array instanceof Uint16Array ) return 65535;
	if ( array instanceof Int32Array ) return 2147483647;
	if ( array instanceof Uint32Array ) return 4294967295;
	return 1;

}

/**
 * Several objects into one geometry.
 *
 * three r122 ships BufferGeometryUtils as a single namespace object, not as named exports —
 * destructuring `mergeBufferGeometries` straight off the module yielded undefined, so every
 * file with more than one object (a cabin with its logo as a separate mesh, say) failed to
 * import while single-object files worked.
 */
export async function mergeGeometries( geometries ) {

	if ( geometries.length === 1 ) return geometries[ 0 ];

	const { BufferGeometryUtils } = await import( '../vendor/BufferGeometryUtils.js' );
	const merged = BufferGeometryUtils.mergeBufferGeometries( geometries );

	if ( ! merged ) throw new Error( 'meshes could not be merged — try joining them in Blender' );
	return merged;

}

async function collectGeometry( gltf, options ) {

	return mergeGeometries( collectParts( gltf, options ).map( p => p.geometry ) );

}

/** Geometry only — for the hill, the blade and the tuft, which are painted in code. */
export async function parseGLB( arrayBuffer ) {

	return collectGeometry( await loadGLTF( arrayBuffer ) );

}

/**
 * The texture a part is painted with: base colour if there is one, otherwise the emissive slot.
 *
 * Exporters that bake lighting into the texture ship it as an *emissive* map over a black base
 * colour — the artist's mountain and cabin both do, their image is literally named "shaded" —
 * so a model that displays perfectly in Blender used to arrive here with nothing in `map`.
 */
function paintOf( material ) {

	if ( ! material ) return { map: null, baked: false, color: [ 0.5, 0.5, 0.5 ] };
	if ( material.map ) return { map: material.map, baked: false };
	if ( material.emissiveMap ) return { map: material.emissiveMap, baked: true };

	// Untextured: whichever colour the part actually shows — emissive when that is what lights it.
	const emissive = material.emissive && ( material.emissive.r + material.emissive.g + material.emissive.b ) > 0;
	const c = emissive ? material.emissive : ( material.color || new THREE.Color( 0.5, 0.5, 0.5 ) );
	return { map: null, baked: emissive, color: [ c.r, c.g, c.b ] };

}

const ATLAS_PADDING = 8;

/**
 * Packs each part's texture into one atlas and moves its UVs into its tile.
 *
 * The mountain and cabin shaders take a single map. A file with two objects painted from two
 * images — the cabin and the emblem on its door — used to be drawn entirely from the first
 * image, so the second object sampled someone else's paint. Packing keeps one material and one
 * draw call. A part with no texture gets a small tile of its flat colour.
 */
function buildAtlas( parts, paints ) {

	const limit = Math.min( 8192, maxTextureSize() );

	const tiles = paints.map( paint => {

		const image = paint.map && paint.map.image;
		return image ? { image, width: image.width, height: image.height } : { color: paint.color, width: 8, height: 8 };

	} );

	// Same image used twice (two objects sharing one material) packs once.
	const unique = [];
	tiles.forEach( tile => {

		const twin = tile.image && unique.find( u => u.image === tile.image );
		tile.slot = twin || tile;
		if ( ! twin ) unique.push( tile );

	} );

	// Shelf packing, tallest first: plenty for the handful of images a prop carries.
	const order = unique.slice().sort( ( a, b ) => b.height - a.height );
	let scale = 1;
	let layout;

	for ( let attempt = 0; attempt < 8; attempt ++ ) {

		layout = shelfPack( order, scale, limit );
		if ( layout ) break;
		scale *= 0.5;

	}

	if ( ! layout ) throw new Error( 'textures are too large to combine' );

	const canvas = document.createElement( 'canvas' );
	canvas.width = layout.width;
	canvas.height = layout.height;
	const context = canvas.getContext( '2d' );

	unique.forEach( tile => {

		const { x, y, w, h } = tile.rect;

		if ( tile.image ) {

			// Stretched into the gutter first, so mip levels bleed the tile's own edge colour
			// rather than the neighbour's.
			context.drawImage( tile.image, x - ATLAS_PADDING, y - ATLAS_PADDING, w + ATLAS_PADDING * 2, h + ATLAS_PADDING * 2 );
			context.drawImage( tile.image, x, y, w, h );

		} else {

			const [ r, g, b ] = tile.color.map( c => Math.round( Math.min( 1, Math.max( 0, c ) ) * 255 ) );
			context.fillStyle = `rgb(${ r },${ g },${ b })`;
			context.fillRect( x - ATLAS_PADDING, y - ATLAS_PADDING, w + ATLAS_PADDING * 2, h + ATLAS_PADDING * 2 );

		}

	} );

	// glTF textures are not flipped (v = 0 is the image's top row); the atlas follows suit, so
	// a tile's v runs down from its top edge.
	parts.forEach( ( part, i ) => {

		const tile = tiles[ i ].slot;
		const { x, y, w, h } = tile.rect;
		const uv = part.geometry.attributes.uv;
		const array = uv.array;

		for ( let k = 0; k < array.length; k += 2 ) {

			const u = tile.image ? Math.min( 1, Math.max( 0, array[ k ] ) ) : 0.5;
			const v = tile.image ? Math.min( 1, Math.max( 0, array[ k + 1 ] ) ) : 0.5;
			array[ k ] = ( x + u * w ) / layout.width;
			array[ k + 1 ] = ( y + v * h ) / layout.height;

		}

		uv.needsUpdate = true;

	} );

	const source = paints.find( p => p.map );
	const texture = new THREE.CanvasTexture( canvas );
	texture.flipY = false;
	texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
	texture.minFilter = THREE.LinearMipMapLinearFilter;
	texture.magFilter = THREE.LinearFilter;
	if ( source ) texture.encoding = source.map.encoding;

	return texture;

}

function shelfPack( tiles, scale, limit ) {

	const pad = ATLAS_PADDING;
	const rowWidth = Math.min( limit, Math.max( ...tiles.map( t => Math.ceil( t.width * scale ) + pad * 2 ) ) * Math.ceil( Math.sqrt( tiles.length ) ) );
	let x = 0, y = 0, row = 0, width = 0;

	for ( const tile of tiles ) {

		const w = Math.max( 1, Math.round( tile.width * scale ) );
		const h = Math.max( 1, Math.round( tile.height * scale ) );

		if ( x + w + pad * 2 > rowWidth && x > 0 ) {

			y += row;
			x = 0;
			row = 0;

		}

		tile.rect = { x: x + pad, y: y + pad, w, h };
		x += w + pad * 2;
		row = Math.max( row, h + pad * 2 );
		width = Math.max( width, x );

	}

	const height = y + row;
	return width <= limit && height <= limit ? { width, height } : null;

}

let cachedMaxTextureSize = 0;

function maxTextureSize() {

	if ( cachedMaxTextureSize ) return cachedMaxTextureSize;

	try {

		const gl = document.createElement( 'canvas' ).getContext( 'webgl' );
		cachedMaxTextureSize = gl ? gl.getParameter( gl.MAX_TEXTURE_SIZE ) : 4096;
		const lose = gl && gl.getExtension( 'WEBGL_lose_context' );
		if ( lose ) lose.loseContext();

	} catch ( error ) {

		cachedMaxTextureSize = 4096;

	}

	return cachedMaxTextureSize;

}

/**
 * Geometry with its UVs, plus the artist's own base-colour texture when the file carries one —
 * for the props that bring their own paint: the mountain and the cabin.
 */
export async function parseGLBWithMap( arrayBuffer ) {

	const gltf = await loadGLTF( arrayBuffer );
	const parts = collectParts( gltf, { keepUV: true } );
	const paints = parts.map( part => paintOf( part.material ) );

	const images = new Set( paints.filter( p => p.map ).map( p => p.map.image ) );
	const needsAtlas = parts[ 0 ].geometry.attributes.uv && images.size > 0 &&
		( images.size > 1 || paints.some( p => ! p.map ) );

	let map = null;
	if ( needsAtlas ) map = buildAtlas( parts, paints );
	else if ( images.size === 1 ) map = paints.find( p => p.map ).map;

	// `baked` means the lighting is already painted in; one baked part is enough to call the
	// whole prop baked, since a single material cannot light half of it.
	const baked = paints.some( p => p.baked );

	// Each object's slice of the merged buffers, in merge order: vertices and index entries are
	// both concatenated part after part, so a part can still be picked out after the merge.
	const ranges = parts.map( p => ( {
		vertices: p.geometry.attributes.position.count,
		indices: p.geometry.index ? p.geometry.index.count : 0
	} ) );

	const geometry = await mergeGeometries( parts.map( p => p.geometry ) );

	const index = geometry.getIndex();
	const triangles = index ? index.count / 3 : geometry.attributes.position.count / 3;

	// `baked` means the lighting is already painted in, so the prop should be drawn unlit —
	// lighting it again from the sky would shade every shadow twice.
	return { geometry, map, baked, triangles, parts: ranges };

}

/**
 * Re-bases a prop so it stands on the origin and runs 0→1 in Y.
 *
 * The blade shader treats `position.y` as the along-the-blade ratio, so a blade modelled
 * two metres tall would bend as though every vertex were past its tip. Normalising means
 * the artist can model at any scale and in any position; only the silhouette matters.
 */
export function normaliseProp( geometry ) {

	geometry.computeBoundingBox();

	const box = geometry.boundingBox;
	const height = Math.max( 1e-6, box.max.y - box.min.y );
	const centreX = ( box.min.x + box.max.x ) * 0.5;
	const centreZ = ( box.min.z + box.max.z ) * 0.5;

	const position = geometry.attributes.position;
	const array = position.array;

	for ( let i = 0; i < array.length; i += 3 ) {

		array[ i ] = ( array[ i ] - centreX ) / height;
		array[ i + 1 ] = ( array[ i + 1 ] - box.min.y ) / height;
		array[ i + 2 ] = ( array[ i + 2 ] - centreZ ) / height;

	}

	position.needsUpdate = true;
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();

	return geometry;

}

/**
 * Guarantees the `yRatio` attribute the plant shader needs, deriving it from height when
 * an imported mesh has none.
 */
export function ensureYRatio( geometry ) {

	if ( geometry.attributes.yRatio ) return geometry;

	geometry.computeBoundingBox();

	const box = geometry.boundingBox;
	const height = Math.max( 1e-6, box.max.y - box.min.y );
	const position = geometry.attributes.position.array;
	const count = geometry.attributes.position.count;
	const yRatio = new Float32Array( count );

	for ( let i = 0; i < count; i ++ ) {

		yRatio[ i ] = ( position[ i * 3 + 1 ] - box.min.y ) / height;

	}

	geometry.setAttribute( 'yRatio', new THREE.BufferAttribute( yRatio, 1 ) );
	return geometry;

}

/** Loads an image file into a texture, matching how flowers.png is configured. */
export function loadImageTexture( file ) {

	return new Promise( ( resolve, reject ) => {

		const url = URL.createObjectURL( file );
		const loader = new THREE.TextureLoader();

		loader.load( url, texture => {

			texture.minFilter = THREE.LinearMipMapLinearFilter;
			texture.magFilter = THREE.LinearFilter;
			URL.revokeObjectURL( url );
			resolve( texture );

		}, undefined, error => {

			URL.revokeObjectURL( url );
			reject( error );

		} );

	} );

}

function download( blob, filename ) {

	const url = URL.createObjectURL( blob );
	const link = document.createElement( 'a' );

	link.href = url;
	link.download = filename;
	document.body.appendChild( link );
	link.click();
	link.remove();

	setTimeout( () => URL.revokeObjectURL( url ), 10000 );

}

/**
 * Exports a bare geometry as .glb, for the artist to open as a starting point.
 *
 * The geometry is stripped to position + normal + uv first. The project's own meshes
 * carry internal attributes — hero_grass.buf has `class`, `pid`, `scale` and `yRatio` —
 * and three's exporter turns anything it does not recognise into a custom accessor
 * (`_CLASS`, `_PID`, …) with an integer component type. Blender's glTF importer rejects
 * the file outright when it meets those, so the export failed at the one step that
 * matters. None of them mean anything to a modeller anyway: `class` is our tuft id and
 * `yRatio` is recomputed from height on the way back in.
 */
export async function exportGeometryGLB( geometry, filename ) {

	const { GLTFExporter } = await import( '../vendor/GLTFExporter.js' );

	const clean = new THREE.BufferGeometry();
	clean.setAttribute( 'position', geometry.attributes.position.clone() );

	if ( geometry.attributes.normal ) clean.setAttribute( 'normal', geometry.attributes.normal.clone() );
	else clean.computeVertexNormals();

	if ( geometry.attributes.uv ) clean.setAttribute( 'uv', geometry.attributes.uv.clone() );
	if ( geometry.getIndex() ) clean.setIndex( geometry.getIndex().clone() );

	const mesh = new THREE.Mesh( clean, new THREE.MeshStandardMaterial( { color: 0x6f8f3a } ) );
	mesh.name = filename.replace( /\.glb$/, '' );

	return new Promise( ( resolve, reject ) => {

		new GLTFExporter().parse( mesh, result => {

			download( new Blob( [ result ], { type: 'model/gltf-binary' } ), filename );
			resolve();

		}, { binary: true, onlyVisible: false } );

		setTimeout( () => reject( new Error( 'export timed out' ) ), 30000 );

	} );

}

/**
 * Writes a texture back out as PNG, so the artist can pull the current flower sheet down
 * and paint over it at the right cell layout.
 *
 * Goes through a canvas because the texture's source may be an <img>, a bitmap or a
 * data-backed image depending on how it was loaded; drawImage normalises all of them.
 */
export function exportTexturePNG( texture, filename ) {

	const image = texture && texture.image;
	if ( ! image ) throw new Error( 'that texture has no image yet' );

	const width = image.width || image.videoWidth;
	const height = image.height || image.videoHeight;
	if ( ! width || ! height ) throw new Error( 'that texture has no size yet' );

	const canvas = document.createElement( 'canvas' );
	canvas.width = width;
	canvas.height = height;

	const context = canvas.getContext( '2d' );
	context.drawImage( image, 0, 0 );

	return new Promise( ( resolve, reject ) => {

		canvas.toBlob( blob => {

			// toBlob yields null when the canvas is tainted by a cross-origin source
			if ( ! blob ) return reject( new Error( 'image is cross-origin and cannot be exported' ) );

			download( blob, filename );
			resolve( { width, height } );

		}, 'image/png' );

	} );

}

export { download };
