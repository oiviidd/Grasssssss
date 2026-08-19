/**
 * Downward-ray sampler over an arbitrary terrain mesh.
 *
 * Everything that has to *sit on the ground* — grass blades, tall-grass clumps,
 * flowers, insects, the baked rock/AO maps — goes through this. It works off raw
 * triangles rather than a height formula, so a hill sculpted in Blender and dropped
 * into assets/models/ reseats the whole scene exactly like the procedural one does.
 *
 * Triangles are bucketed into a uniform xz grid once, so a sample touches only the
 * handful of triangles overlapping that cell.
 */
import * as THREE from '../vendor/three.module.js';

export class TerrainSurface {

	constructor( geometry, cells = 96 ) {

		this.geometry = geometry;

		const position = geometry.attributes.position;
		const index = geometry.getIndex();

		this.positions = position.array;
		this.indices = index ? index.array : null;
		this.triangleCount = this.indices
			? this.indices.length / 3
			: position.count / 3;

		geometry.computeBoundingBox();
		this.boundingBox = geometry.boundingBox.clone();

		const min = this.boundingBox.min;
		const max = this.boundingBox.max;

		this.minX = min.x;
		this.minZ = min.z;
		this.sizeX = Math.max( 1e-6, max.x - min.x );
		this.sizeZ = Math.max( 1e-6, max.z - min.z );
		this.cells = cells;

		this._buildBuckets();

	}

	_cellX( x ) {

		return Math.min( this.cells - 1, Math.max( 0,
			Math.floor( ( x - this.minX ) / this.sizeX * this.cells ) ) );

	}

	_cellZ( z ) {

		return Math.min( this.cells - 1, Math.max( 0,
			Math.floor( ( z - this.minZ ) / this.sizeZ * this.cells ) ) );

	}

	_buildBuckets() {

		const cells = this.cells;
		const buckets = new Array( cells * cells );

		for ( let i = 0; i < buckets.length; i ++ ) buckets[ i ] = [];

		const p = this.positions;
		const idx = this.indices;

		for ( let t = 0; t < this.triangleCount; t ++ ) {

			const a = ( idx ? idx[ t * 3 ] : t * 3 ) * 3;
			const b = ( idx ? idx[ t * 3 + 1 ] : t * 3 + 1 ) * 3;
			const c = ( idx ? idx[ t * 3 + 2 ] : t * 3 + 2 ) * 3;

			const x0 = Math.min( p[ a ], p[ b ], p[ c ] );
			const x1 = Math.max( p[ a ], p[ b ], p[ c ] );
			const z0 = Math.min( p[ a + 2 ], p[ b + 2 ], p[ c + 2 ] );
			const z1 = Math.max( p[ a + 2 ], p[ b + 2 ], p[ c + 2 ] );

			const cx0 = this._cellX( x0 ), cx1 = this._cellX( x1 );
			const cz0 = this._cellZ( z0 ), cz1 = this._cellZ( z1 );

			for ( let cz = cz0; cz <= cz1; cz ++ ) {

				for ( let cx = cx0; cx <= cx1; cx ++ ) {

					buckets[ cz * cells + cx ].push( t );

				}

			}

		}

		// flatten to typed arrays — 48k+ scatter queries hit this hard
		this.bucketStart = new Uint32Array( cells * cells + 1 );
		let total = 0;
		for ( let i = 0; i < buckets.length; i ++ ) {

			this.bucketStart[ i ] = total;
			total += buckets[ i ].length;

		}
		this.bucketStart[ buckets.length ] = total;

		this.bucketItems = new Uint32Array( total );
		let k = 0;
		for ( let i = 0; i < buckets.length; i ++ ) {

			const list = buckets[ i ];
			for ( let j = 0; j < list.length; j ++ ) this.bucketItems[ k ++ ] = list[ j ];

		}

	}

	/**
	 * Highest surface point directly below/above (x, z).
	 * Writes into `target` and returns it, or returns null when (x, z) misses the mesh.
	 */
	sample( x, z, target = { y: 0, nx: 0, ny: 1, nz: 0 } ) {

		const cells = this.cells;
		const cell = this._cellZ( z ) * cells + this._cellX( x );
		const start = this.bucketStart[ cell ];
		const end = this.bucketStart[ cell + 1 ];

		const p = this.positions;
		const idx = this.indices;

		let bestY = - Infinity;
		let found = false;

		for ( let i = start; i < end; i ++ ) {

			const t = this.bucketItems[ i ];
			const ia = ( idx ? idx[ t * 3 ] : t * 3 ) * 3;
			const ib = ( idx ? idx[ t * 3 + 1 ] : t * 3 + 1 ) * 3;
			const ic = ( idx ? idx[ t * 3 + 2 ] : t * 3 + 2 ) * 3;

			const ax = p[ ia ], az = p[ ia + 2 ];
			const bx = p[ ib ], bz = p[ ib + 2 ];
			const cx = p[ ic ], cz = p[ ic + 2 ];

			// barycentric containment test in the xz plane
			const d = ( bz - cz ) * ( ax - cx ) + ( cx - bx ) * ( az - cz );
			if ( d === 0 ) continue;

			const w0 = ( ( bz - cz ) * ( x - cx ) + ( cx - bx ) * ( z - cz ) ) / d;
			if ( w0 < - 1e-6 || w0 > 1 + 1e-6 ) continue;

			const w1 = ( ( cz - az ) * ( x - cx ) + ( ax - cx ) * ( z - cz ) ) / d;
			if ( w1 < - 1e-6 || w1 > 1 + 1e-6 ) continue;

			const w2 = 1 - w0 - w1;
			if ( w2 < - 1e-6 || w2 > 1 + 1e-6 ) continue;

			const y = w0 * p[ ia + 1 ] + w1 * p[ ib + 1 ] + w2 * p[ ic + 1 ];

			if ( y > bestY ) {

				bestY = y;
				found = true;

				// geometric face normal, forced to point up
				const e1x = bx - ax, e1y = p[ ib + 1 ] - p[ ia + 1 ], e1z = bz - az;
				const e2x = cx - ax, e2y = p[ ic + 1 ] - p[ ia + 1 ], e2z = cz - az;

				let nx = e1y * e2z - e1z * e2y;
				let ny = e1z * e2x - e1x * e2z;
				let nz = e1x * e2y - e1y * e2x;

				const len = Math.hypot( nx, ny, nz ) || 1;
				nx /= len; ny /= len; nz /= len;
				if ( ny < 0 ) { nx = - nx; ny = - ny; nz = - nz; }

				target.nx = nx; target.ny = ny; target.nz = nz;

			}

		}

		if ( ! found ) return null;

		target.y = bestY;
		return target;

	}

	/**
	 * Raster of surface heights over the stage — the input for the rock/AO bake.
	 *
	 * The stage is a square of `stageSize` centred on (centreX, centreZ) rather than on the
	 * origin, so a hill sculpted off-centre is still covered edge to edge.
	 */
	rasterize( resolution, stageSize = 10, centreX = 0, centreZ = 0 ) {

		const heights = new Float32Array( resolution * resolution );
		const slopes = new Float32Array( resolution * resolution );
		const hit = new Uint8Array( resolution * resolution );
		const sample = { y: 0, nx: 0, ny: 1, nz: 0 };

		for ( let j = 0; j < resolution; j ++ ) {

			// v maps to +z, matching the shader's `( worldPosition.xz - u_stageCentre ) / u_stageSize + 0.5`
			const z = ( ( j + 0.5 ) / resolution - 0.5 ) * stageSize + centreZ;

			for ( let i = 0; i < resolution; i ++ ) {

				const x = ( ( i + 0.5 ) / resolution - 0.5 ) * stageSize + centreX;
				const k = j * resolution + i;
				const result = this.sample( x, z, sample );

				if ( result ) {

					heights[ k ] = sample.y;
					slopes[ k ] = 1 - sample.ny;   // 0 = flat, →1 = vertical
					hit[ k ] = 1;

				} else {

					heights[ k ] = this.boundingBox.min.y;
					slopes[ k ] = 0;

				}

			}

		}

		return { heights, slopes, hit, resolution, stageSize, centreX, centreZ };

	}

}
