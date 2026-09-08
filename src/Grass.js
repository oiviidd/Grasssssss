/**
 * Grass, in the same two layers the original uses:
 *
 *   1. INSTANCED BLADES — one 7-vertex blade drawn tens of thousands of times. This is
 *      the carpet. Every blade reads the wind field from its own world position, so
 *      gusts travel across the meadow as coherent waves rather than a global sway.
 *
 *   2. SCULPTED TUFTS — hero_grass.buf, a hand-modelled mesh of 462 tall tufts (its
 *      `class` attribute is the tuft id, ~10 verts each). They were authored in a line
 *      along the original river bank, so each tuft is detached from that line, re-seated
 *      on our hill and given a fresh yaw and scale. The hand-sculpted silhouette is
 *      what is worth keeping; its original placement is not.
 */
import * as THREE from '../vendor/three.module.js';
import { loadBuf } from './BufLoader.js';
import { PRECISION_PREFIX } from './FboHelper.js';
import { instancedGrassVert, instancedGrassFrag, plantVert, plantFrag } from './glsl/grass.js';
import { scatterOnSurface, orientToNormal, makeRandom } from './Scatter.js';

/** Shrinks a footprint inward, for props that should keep clear of the very edge. */
function insetBounds( bounds, amount ) {

	return {
		minX: bounds.minX + amount,
		maxX: bounds.maxX - amount,
		minZ: bounds.minZ + amount,
		maxZ: bounds.maxZ - amount
	};

}

// straight off grass_placement.buf's packed header — the original blade scale range
const BLADE_SCALE_MIN = 0.0795090646;
const BLADE_SCALE_RANGE = 0.2189329114;

/**
 * Ceiling on total tuft vertices.
 *
 * Placement cost is instances x vertices-per-group, and those two vary wildly. The
 * original mesh splits into 462 groups of ~11 vertices, so 2310 placements costs ~25k
 * vertices. An imported .glb carries no `class` attribute, so the whole mesh becomes a
 * single group — at the same 2310 placements a 5k-vertex clump asks for 11.7 million
 * vertices and the tab locks up. Instances are clamped to fit this budget instead.
 */
const MAX_TUFT_VERTICES = 600000;

export class Grass {

	constructor( uniforms ) {

		this.container = new THREE.Object3D();
		this.uniforms = uniforms;
		this.bladeCount = 0;
		this.tuftCount = 0;

	}

	async load( modelPath ) {

		const [ blade, tufts ] = await Promise.all( [
			loadBuf( modelPath + 'grass.buf' ),
			loadBuf( modelPath + 'hero_grass.buf' )
		] );

		this.bladeGeometry = blade;
		this.tuftGeometry = tufts;

	}

	build( surface, options = {} ) {

		this._buildBlades( surface, options );
		this._buildTufts( surface, options );

	}

	/**
	 * Tear down the built meshes so build() can run again with different options.
	 *
	 * Materials are left alone deliberately — they hold references to the shared uniform
	 * objects, and disposing them would orphan the live textures the rest of the scene is
	 * still using.
	 */
	dispose() {

		for ( const mesh of [ this.bladeMesh, this.tuftMesh ] ) {

			if ( ! mesh ) continue;
			this.container.remove( mesh );
			mesh.geometry.dispose();

		}

		this.bladeMesh = null;
		this.tuftMesh = null;
		this.bladeCount = 0;
		this.tuftCount = 0;

	}

	/**
	 * One clump, standing on the origin, as a standalone geometry.
	 *
	 * This is what "Export tuft" hands over, not the whole source mesh. hero_grass.buf
	 * holds 462 tufts in one buffer separated only by its `class` attribute — an attribute
	 * .glb cannot carry. Exporting all of them would come back as a single 462-tuft clump
	 * scattered as one prop, so the export has to match what the importer expects: one
	 * tuft in, one tuft out.
	 */
	representativeTuft() {

		const source = this.tuftGeometry;
		if ( ! source ) return null;

		const classAttribute = source.attributes[ 'class' ];
		if ( ! classAttribute ) return source;

		const ids = classAttribute.array;
		const vertexCount = source.attributes.position.count;

		// pick the densest group, so the artist gets a fully formed clump rather than a
		// stray two-triangle fragment
		const counts = new Map();
		for ( let v = 0; v < vertexCount; v ++ ) counts.set( ids[ v ], ( counts.get( ids[ v ] ) || 0 ) + 1 );

		let bestId = null, bestCount = - 1;
		counts.forEach( ( count, id ) => { if ( count > bestCount ) { bestCount = count; bestId = id; } } );

		const remap = new Int32Array( vertexCount ).fill( - 1 );
		const positions = [];
		const normals = [];

		const sourcePositions = source.attributes.position.array;
		const sourceNormals = source.attributes.normal.array;

		let minY = Infinity, cx = 0, cz = 0, kept = 0;

		for ( let v = 0; v < vertexCount; v ++ ) {

			if ( ids[ v ] !== bestId ) continue;
			const o = v * 3;

			remap[ v ] = kept ++;
			positions.push( sourcePositions[ o ], sourcePositions[ o + 1 ], sourcePositions[ o + 2 ] );
			normals.push( sourceNormals[ o ], sourceNormals[ o + 1 ], sourceNormals[ o + 2 ] );

			cx += sourcePositions[ o ];
			cz += sourcePositions[ o + 2 ];
			if ( sourcePositions[ o + 1 ] < minY ) minY = sourcePositions[ o + 1 ];

		}

		if ( kept === 0 ) return null;

		cx /= kept;
		cz /= kept;

		// re-base onto the origin so it opens in Blender sitting on the floor
		for ( let i = 0; i < positions.length; i += 3 ) {

			positions[ i ] -= cx;
			positions[ i + 1 ] -= minY;
			positions[ i + 2 ] -= cz;

		}

		const indices = [];
		const sourceIndex = source.getIndex();

		if ( sourceIndex ) {

			const array = sourceIndex.array;
			for ( let i = 0; i < array.length; i += 3 ) {

				const a = remap[ array[ i ] ], b = remap[ array[ i + 1 ] ], c = remap[ array[ i + 2 ] ];
				if ( a < 0 || b < 0 || c < 0 ) continue;
				indices.push( a, b, c );

			}

		}

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( positions ), 3 ) );
		geometry.setAttribute( 'normal', new THREE.BufferAttribute( new Float32Array( normals ), 3 ) );
		if ( indices.length ) geometry.setIndex( new THREE.BufferAttribute( new Uint16Array( indices ), 1 ) );

		return geometry;

	}

	_material( vertexShader, fragmentShader, extraUniforms ) {

		return new THREE.RawShaderMaterial( {
			uniforms: Object.assign( {
				u_time: this.uniforms.u_time,
				u_envTexture: this.uniforms.u_envTexture,
				u_fogBox: this.uniforms.u_fogBox,
				u_fogCentre: this.uniforms.u_fogCentre,
				u_fogRadius: this.uniforms.u_fogRadius,
				u_fogStart: this.uniforms.u_fogStart,
				u_fogRange: this.uniforms.u_fogRange,
				u_hazeStart: this.uniforms.u_hazeStart,
				u_hazeRange: this.uniforms.u_hazeRange,
				u_hazeAmount: this.uniforms.u_hazeAmount,
				u_terrainGrassTexture: this.uniforms.u_terrainGrassTexture,
				u_terrainDrawTexture: this.uniforms.u_terrainDrawTexture,
				u_stageCentre: this.uniforms.u_stageCentre,
				u_stageSize: this.uniforms.u_stageSize
			}, extraUniforms ),
			vertexShader: PRECISION_PREFIX + vertexShader,
			fragmentShader: PRECISION_PREFIX + fragmentShader,
			side: THREE.DoubleSide
		} );

	}

	/* ── layer 1: the carpet ───────────────────────────────────────────────────── */

	_buildBlades( surface, options ) {

		// The original's 48 768 placements covered a terrain with a river through it; an
		// unbroken meadow filling the same frame needs materially more, or the carpet
		// reads as mown lawn with visible ground between the blades.
		const scatter = scatterOnSurface( surface, {
			count: options.bladeCount !== undefined ? options.bladeCount : 130000,
			seed: 1337,
			bounds: options.bounds,
			rimRadius: options.rimRadius,
			rimFade: options.rimFade,
			maxSlope: options.maxSlope,
			upBlend: 0.35
		} );

		const random = makeRandom( 909 );
		const count = scatter.count;

		// instanceSize scales the blade uniformly, so narrowing via bladeWidthScale without
		// touching this makes blades more slender rather than smaller — at 0.42 they read as
		// tall thin spikes instead of grass. This shortens them back independently.
		const heightScale = options.bladeHeightScale !== undefined ? options.bladeHeightScale : 1;

		const orients = new Float32Array( count * 4 );
		const sizes = new Float32Array( count );
		const quaternion = new THREE.Quaternion();

		for ( let i = 0; i < count; i ++ ) {

			orientToNormal(
				scatter.normals[ i * 3 ],
				scatter.normals[ i * 3 + 1 ],
				scatter.normals[ i * 3 + 2 ],
				random() * Math.PI * 2,
				quaternion
			);

			orients[ i * 4 ] = quaternion.x;
			orients[ i * 4 + 1 ] = quaternion.y;
			orients[ i * 4 + 2 ] = quaternion.z;
			orients[ i * 4 + 3 ] = quaternion.w;

			// biased toward shorter blades, so the tall ones read as accents
			sizes[ i ] = ( BLADE_SCALE_MIN + Math.pow( random(), 1.55 ) * BLADE_SCALE_RANGE ) * heightScale;

		}

		const geometry = new THREE.InstancedBufferGeometry();

		for ( const name in this.bladeGeometry.attributes ) {

			geometry.setAttribute( name, this.bladeGeometry.attributes[ name ] );

		}
		geometry.setIndex( this.bladeGeometry.getIndex() );

		// The source blade is a flat strip 0.113 wide and 1 tall (grass.buf's packed
		// header), scaled uniformly per instance. Narrowing it *without* shortening it is
		// the only way to raise apparent grass fineness on its own: instanceSize scales
		// both axes, so shrinking that would drop blade height too and flatten the
		// skyline. Measured as edge frequency — luminance sign changes per frame width.
		const widthScale = options.bladeWidthScale !== undefined ? options.bladeWidthScale : 1;

		if ( widthScale !== 1 ) {

			const source = this.bladeGeometry.attributes.position;
			const narrowed = new THREE.BufferAttribute( Float32Array.from( source.array ), 3 );

			for ( let i = 0; i < narrowed.array.length; i += 3 ) narrowed.array[ i ] *= widthScale;

			geometry.setAttribute( 'position', narrowed );

		}

		geometry.setAttribute( 'instancePosition', new THREE.InstancedBufferAttribute( scatter.positions, 3 ) );
		geometry.setAttribute( 'instanceQrient', new THREE.InstancedBufferAttribute( orients, 4 ) );
		geometry.setAttribute( 'instanceSize', new THREE.InstancedBufferAttribute( sizes, 1 ) );
		geometry.instanceCount = count;

		const mesh = new THREE.Mesh(
			geometry,
			this._material( instancedGrassVert, instancedGrassFrag )
		);

		mesh.renderOrder = 0;
		mesh.frustumCulled = false;

		this.bladeMesh = mesh;
		this.bladeCount = count;
		this.container.add( mesh );

	}

	/* ── layer 2: the sculpted tufts ───────────────────────────────────────────── */

	_buildTufts( surface, options ) {

		const source = this.tuftGeometry;
		if ( ! source || ! source.attributes.position ) return;

		const sourcePositions = source.attributes.position.array;
		const sourceNormals = source.attributes.normal.array;
		const vertexCount = source.attributes.position.count;

		// hero_grass.buf packs 462 separate tufts into one mesh, tagged by a `class`
		// attribute. An imported .glb has no such tag, so the whole mesh is treated as a
		// single tuft and simply scattered more times.
		const classAttribute = source.attributes[ 'class' ];
		const groups = new Map();

		if ( classAttribute ) {

			const ids = classAttribute.array;
			for ( let v = 0; v < vertexCount; v ++ ) {

				let group = groups.get( ids[ v ] );
				if ( ! group ) groups.set( ids[ v ], group = [] );
				group.push( v );

			}

		} else {

			const all = new Array( vertexCount );
			for ( let v = 0; v < vertexCount; v ++ ) all[ v ] = v;
			groups.set( 0, all );

		}

		const groupList = Array.from( groups.values() );
		const groupKeys = Array.from( groups.keys() );

		// Triangles bucketed per group, once. Scanning the whole index for every placement
		// would be O(placements x indices) — ~32M iterations at typical settings.
		//
		// `class` is not a clean partition of hero_grass.buf: 401 of its 4366 triangles
		// bridge two neighbouring tufts, which were adjacent on the original river bank.
		// Once the tufts are scattered those stretch right across the map as a dark sliver,
		// so any triangle spanning two groups is dropped here.
		const sourceIndexArray = source.getIndex() ? source.getIndex().array : null;
		const idArray = classAttribute ? classAttribute.array : null;
		const trianglesByGroup = new Map();

		if ( sourceIndexArray ) {

			for ( const key of groupKeys ) trianglesByGroup.set( key, [] );

			for ( let i = 0; i < sourceIndexArray.length; i += 3 ) {

				const a = sourceIndexArray[ i ], b = sourceIndexArray[ i + 1 ], c = sourceIndexArray[ i + 2 ];
				const key = idArray ? idArray[ a ] : 0;

				if ( idArray && ( idArray[ a ] !== idArray[ b ] || idArray[ b ] !== idArray[ c ] ) ) continue;

				const bucket = trianglesByGroup.get( key );
				if ( bucket ) bucket.push( a, b, c );

			}

		}
		const rimRadius = ( options.rimRadius !== undefined ? options.rimRadius : 4.7 ) - 0.4;
		const tuftScale = options.tuftScale !== undefined ? options.tuftScale : 1;

		// A total placement count rather than a repeat factor, so the control means the same
		// thing whether the source holds 462 tufts or one imported clump.
		const requested = Math.max( 0, Math.round(
			options.tuftInstances !== undefined ? options.tuftInstances : groupList.length * 5
		) );

		if ( requested === 0 || groupList.length === 0 ) return;

		const averageGroupSize = vertexCount / groupList.length;
		const affordable = Math.max( 1, Math.floor( MAX_TUFT_VERTICES / averageGroupSize ) );
		const instances = Math.min( requested, affordable );

		this.tuftClamped = instances < requested ? { requested, instances } : null;

		const scatter = scatterOnSurface( surface, {
			count: instances,
			seed: 4242,
			bounds: options.bounds ? insetBounds( options.bounds, 0.4 ) : null,
			rimRadius,
			rimFade: options.rimFade,
			// tufts are pickier about slope than the carpet, but still follow the setting
			maxSlope: options.maxSlope !== undefined ? options.maxSlope * 0.8 : 0.5,
			patchScale: 0.7,
			patchStrength: 0.8,
			upBlend: 0.55
		} );

		if ( scatter.count === 0 ) return;

		// Groups differ in size, so the buffer length depends on which ones actually get
		// placed — walk the placement order first and total it up.
		const plan = [];
		let totalVertices = 0;

		for ( let i = 0; i < scatter.count; i ++ ) {

			const group = groupList[ i % groupList.length ];
			plan.push( group );
			totalVertices += group.length;

		}

		const positions = new Float32Array( totalVertices * 3 );
		const normals = new Float32Array( totalVertices * 3 );
		const yRatios = new Float32Array( totalVertices );
		const sourceYRatio = source.attributes.yRatio ? source.attributes.yRatio.array : null;

		const random = makeRandom( 77 );
		const quaternion = new THREE.Quaternion();
		const vector = new THREE.Vector3();

		// index remap, since vertices are re-emitted per placement
		const remap = new Int32Array( vertexCount );
		const keptIndices = [];
		let write = 0;

		for ( let p = 0; p < plan.length; p ++ ) {

			const group = plan[ p ];

			// tuft root: centroid in xz, lowest point in y
			let cx = 0, cz = 0, minY = Infinity, maxY = - Infinity;

			for ( let i = 0; i < group.length; i ++ ) {

				const o = group[ i ] * 3;
				cx += sourcePositions[ o ];
				cz += sourcePositions[ o + 2 ];
				if ( sourcePositions[ o + 1 ] < minY ) minY = sourcePositions[ o + 1 ];
				if ( sourcePositions[ o + 1 ] > maxY ) maxY = sourcePositions[ o + 1 ];

			}

			cx /= group.length;
			cz /= group.length;
			const span = Math.max( 1e-6, maxY - minY );

			const tx = scatter.positions[ p * 3 ];
			const ty = scatter.positions[ p * 3 + 1 ];
			const tz = scatter.positions[ p * 3 + 2 ];

			orientToNormal(
				scatter.normals[ p * 3 ],
				scatter.normals[ p * 3 + 1 ],
				scatter.normals[ p * 3 + 2 ],
				random() * Math.PI * 2,
				quaternion
			);

			// Tuft height is the lever for skyline raggedness, and it has to be separate from
			// blade width. Narrow blades raise edge frequency but *lower* raggedness — thin
			// tips stop registering above the green threshold — and adding more tufts makes
			// the canopy more uniform rather than more ragged. The reference gets both
			// because its fine carpet and its tall wisps are different elements.
			const scale = ( 0.75 + random() * 0.75 ) * tuftScale;

			const base = write;

			for ( let i = 0; i < group.length; i ++ ) {

				const v = group[ i ];
				const o = v * 3;
				const w = write * 3;

				vector.set(
					( sourcePositions[ o ] - cx ) * scale,
					( sourcePositions[ o + 1 ] - minY ) * scale,
					( sourcePositions[ o + 2 ] - cz ) * scale
				).applyQuaternion( quaternion );

				positions[ w ] = vector.x + tx;
				positions[ w + 1 ] = vector.y + ty;
				positions[ w + 2 ] = vector.z + tz;

				vector.set( sourceNormals[ o ], sourceNormals[ o + 1 ], sourceNormals[ o + 2 ] )
					.applyQuaternion( quaternion );

				normals[ w ] = vector.x;
				normals[ w + 1 ] = vector.y;
				normals[ w + 2 ] = vector.z;

				// fall back to normalised height when the source carries no yRatio
				yRatios[ write ] = sourceYRatio
					? sourceYRatio[ v ]
					: ( sourcePositions[ o + 1 ] - minY ) / span;

				remap[ v ] = base + i;
				write ++;

			}

			// emit this placement's pre-bucketed triangles through the vertex remap
			const bucket = trianglesByGroup.get( groupKeys[ p % groupKeys.length ] );

			if ( bucket ) {

				for ( let i = 0; i < bucket.length; i += 3 ) {

					keptIndices.push( remap[ bucket[ i ] ], remap[ bucket[ i + 1 ] ], remap[ bucket[ i + 2 ] ] );

				}

			}

		}

		const IndexArray = totalVertices > 65535 ? Uint32Array : Uint16Array;

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
		geometry.setAttribute( 'yRatio', new THREE.BufferAttribute( yRatios, 1 ) );
		geometry.setIndex( new THREE.BufferAttribute( new IndexArray( keptIndices ), 1 ) );

		const mesh = new THREE.Mesh(
			geometry,
			this._material( plantVert, plantFrag, { u_movementStrength: { value: 1 } } )
		);

		mesh.frustumCulled = false;

		this.tuftMesh = mesh;
		this.tuftCount = plan.length;
		this.container.add( mesh );

	}

}
