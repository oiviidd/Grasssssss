/**
 * Blender hand-off.
 *
 * The hill is the one asset worth sculpting by hand, so it round-trips:
 *
 *   EXPORT — press G (glb) or O (obj) to download the current procedural hill.
 *   EDIT   — sculpt it in Blender. Keep these rules and nothing else needs changing:
 *              · Y up, Z forward  (Blender's glTF exporter does this by default)
 *              · put it anywhere — the stage box the terrain maps cover is fitted to the
 *                mesh's own bounds on import, so an off-centre sculpt is still covered
 *                edge to edge. The fog box does stay on the origin, so a hill far from
 *                it will haze asymmetrically until the fog sliders are retuned
 *              · keep the height range roughly within ±1 unit; grass blades are only
 *                0.08 – 0.30 tall and the proportion is what sells the scale
 *              · let the rim (|x| or |z| > ~3.5) fall away — the fog SDF dissolves the
 *                ground past there, and a hard edge out there reads as a cut
 *              · one mesh, triangles or quads, normals exported, no modifiers pending
 *   RELOAD — save as assets/models/terrain_custom.glb. It is picked up automatically on
 *            the next reload; the grass, tufts and flowers all re-seat onto it, and the
 *            rock/AO/albedo maps are re-baked from its slopes.
 */
import * as THREE from '../vendor/three.module.js';

function download( blob, filename ) {

	const url = URL.createObjectURL( blob );
	const link = document.createElement( 'a' );

	link.href = url;
	link.download = filename;
	document.body.appendChild( link );
	link.click();
	document.body.removeChild( link );

	// give the browser a beat to start the download before revoking
	setTimeout( () => URL.revokeObjectURL( url ), 10000 );

}

export async function exportGLB( mesh, filename = 'terrain.glb' ) {

	const { GLTFExporter } = await import( '../vendor/GLTFExporter.js' );

	// export the geometry alone — the study's materials are all custom GLSL and mean
	// nothing to Blender
	const plain = new THREE.Mesh( mesh.geometry, new THREE.MeshStandardMaterial( { color: 0x6f8f3a } ) );
	plain.name = 'Hill';

	return new Promise( ( resolve, reject ) => {

		new GLTFExporter().parse(
			plain,
			result => {

				download( new Blob( [ result ], { type: 'model/gltf-binary' } ), filename );
				resolve();

			},
			{ binary: true, onlyVisible: false }
		);

		// r122's exporter has no error callback; guard against a silent hang
		setTimeout( () => reject( new Error( 'GLB export timed out' ) ), 30000 );

	} );

}

export function exportOBJ( mesh, filename = 'terrain.obj' ) {

	const geometry = mesh.geometry;
	const positions = geometry.attributes.position.array;
	const normals = geometry.attributes.normal ? geometry.attributes.normal.array : null;
	const index = geometry.getIndex();

	const lines = [ '# Hill exported from the grass study — 10 x 10 unit stage, Y up' ];

	for ( let i = 0; i < positions.length; i += 3 ) {

		lines.push( 'v ' + positions[ i ].toFixed( 5 ) + ' ' + positions[ i + 1 ].toFixed( 5 ) + ' ' + positions[ i + 2 ].toFixed( 5 ) );

	}

	if ( normals ) {

		for ( let i = 0; i < normals.length; i += 3 ) {

			lines.push( 'vn ' + normals[ i ].toFixed( 5 ) + ' ' + normals[ i + 1 ].toFixed( 5 ) + ' ' + normals[ i + 2 ].toFixed( 5 ) );

		}

	}

	const emit = ( a, b, c ) => {

		// OBJ indices are 1-based
		const A = a + 1, B = b + 1, C = c + 1;
		lines.push( normals
			? 'f ' + A + '//' + A + ' ' + B + '//' + B + ' ' + C + '//' + C
			: 'f ' + A + ' ' + B + ' ' + C );

	};

	if ( index ) {

		const array = index.array;
		for ( let i = 0; i < array.length; i += 3 ) emit( array[ i ], array[ i + 1 ], array[ i + 2 ] );

	} else {

		const count = geometry.attributes.position.count;
		for ( let i = 0; i < count; i += 3 ) emit( i, i + 1, i + 2 );

	}

	download( new Blob( [ lines.join( '\n' ) ], { type: 'text/plain' } ), filename );

}

/**
 * Loads a sculpted hill if one is present, otherwise resolves null so the caller falls
 * back to the procedural generator. Merges every mesh in the file into one geometry
 * with world transforms baked, which is what TerrainSurface expects.
 */
export async function loadCustomTerrain( url ) {

	let response;

	try {

		response = await fetch( url, { method: 'HEAD' } );

	} catch ( error ) {

		return null;

	}

	if ( ! response.ok ) return null;

	const { GLTFLoader } = await import( '../vendor/GLTFLoader.js' );

	const gltf = await new Promise( ( resolve, reject ) => {

		new GLTFLoader().load( url, resolve, undefined, reject );

	} );

	const geometries = [];

	gltf.scene.updateMatrixWorld( true );
	gltf.scene.traverse( object => {

		if ( ! object.isMesh ) return;

		const geometry = object.geometry.clone();
		geometry.applyMatrix4( object.matrixWorld );

		// keep only what the terrain shader reads, so the merge cannot fail on
		// mismatched attribute sets between primitives
		for ( const name in geometry.attributes ) {

			if ( name !== 'position' && name !== 'normal' ) geometry.deleteAttribute( name );

		}

		if ( ! geometry.attributes.normal ) geometry.computeVertexNormals();
		if ( ! geometry.getIndex() ) {

			const count = geometry.attributes.position.count;
			const indices = new Uint32Array( count );
			for ( let i = 0; i < count; i ++ ) indices[ i ] = i;
			geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );

		}

		geometries.push( geometry );

	} );

	if ( geometries.length === 0 ) return null;
	if ( geometries.length === 1 ) return geometries[ 0 ];

	const { mergeBufferGeometries } = await import( '../vendor/BufferGeometryUtils.js' );
	return mergeBufferGeometries( geometries );

}
