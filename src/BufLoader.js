/**
 * Loader for Lusion's custom ".buf" geometry container.
 *
 * Layout:  [uint32 headerLength][utf8 JSON header][packed attribute data]
 *
 * Every attribute is stored back-to-back in header order. Attributes with
 * `needsPack: true` are quantised into an integer array and are restored with
 * a per-component `from` / `delta` range:
 *
 *     value = (raw + signedOffset) / 2^bits * delta + from
 *
 * Ported 1:1 from the original site's loader so the decoded floats are bit-for
 * bit identical to what the original runtime produces.
 */
import * as THREE from '../vendor/three.module.js';

const STORAGE_TYPES = {
	Int8Array,
	Uint8Array,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array
};

export function parseBuf( arrayBuffer ) {

	const headerLength = new Uint32Array( arrayBuffer, 0, 1 )[ 0 ];
	const header = JSON.parse(
		new TextDecoder().decode( new Uint8Array( arrayBuffer, 4, headerLength ) )
	);

	const vertexCount = header.vertexCount;
	const indexCount = header.indexCount;

	let offset = 4 + headerLength;

	const geometry = new THREE.BufferGeometry();
	const attributes = header.attributes;

	for ( let i = 0, l = attributes.length; i < l; i ++ ) {

		const attribute = attributes[ i ];
		const id = attribute.id;
		const count = id === 'indices' ? indexCount : vertexCount;
		const componentSize = attribute.componentSize;
		const StorageType = STORAGE_TYPES[ attribute.storageType ];
		const raw = new StorageType( arrayBuffer, offset, count * componentSize );
		const bytesPerElement = StorageType.BYTES_PER_ELEMENT;

		let array;

		if ( attribute.needsPack ) {

			const packed = attribute.packedComponents;
			const componentCount = packed.length;
			const range = 1 << ( 8 * bytesPerElement );
			// signed storage is centred on zero, so shift it back into [0, range)
			const signedOffset = attribute.storageType.indexOf( 'Int' ) === 0 ? 0.5 * range : 0;
			const inverseRange = 1 / range;

			array = new Float32Array( count * componentSize );

			for ( let v = 0, k = 0; v < count; v ++ ) {

				for ( let c = 0; c < componentCount; c ++ ) {

					const component = packed[ c ];
					array[ k ] = ( raw[ k ] + signedOffset ) * inverseRange * component.delta + component.from;
					k ++;

				}

			}

		} else {

			array = raw;

		}

		if ( id === 'indices' ) {

			geometry.setIndex( new THREE.BufferAttribute( array, 1 ) );

		} else {

			geometry.setAttribute( id, new THREE.BufferAttribute( array, componentSize ) );

		}

		offset += count * componentSize * bytesPerElement;

	}

	geometry.userData.meshType = header.meshType;

	return geometry;

}

export function loadBuf( url ) {

	return fetch( url )
		.then( response => {

			if ( ! response.ok ) throw new Error( `${url} → ${response.status}` );
			return response.arrayBuffer();

		} )
		.then( parseBuf );

}
