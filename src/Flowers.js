/**
 * Instanced flower billboards seated on the hill.
 *
 * The original's flower_placement.buf holds only 128 points, laid out along the river
 * bank, so — like the grass — the placement is regenerated and only its authored
 * constants are reused: 5 atlas cells, a 0.3 × 0.512 quad pivoted at its base, and a
 * per-instance scale in [0.800, 0.997].
 */
import * as THREE from '../vendor/three.module.js';
import { PRECISION_PREFIX } from './FboHelper.js';
import { flowerVert, flowerFrag } from './glsl/flowers.js';
import { scatterOnSurface, makeRandom } from './Scatter.js';

const DEFAULT_ATLAS_CELLS = 5;

// from flower_placement.buf's packed header
const FLOWER_SCALE_MIN = 0.800330758;
const FLOWER_SCALE_RANGE = 0.197057664;

export class Flowers {

	constructor( uniforms ) {

		this.container = new THREE.Object3D();
		this.uniforms = uniforms;
		this.count = 0;

	}

	/** Mirror of Grass.dispose() — lets the panel rebuild without a reload. */
	dispose() {

		if ( ! this.mesh ) return;
		this.container.remove( this.mesh );
		this.mesh.geometry.dispose();
		this.mesh = null;
		this.count = 0;

	}

	build( surface, texture, options = {} ) {

		const scatter = scatterOnSurface( surface, {
			// the count is a ceiling, not a target — the slope/patch/rim rejection below
			// throws most candidates away, so ask for roughly 2.5x what you want
			count: options.flowerCount !== undefined ? options.flowerCount : 1100,
			seed: 5150,
			bounds: options.bounds ? {
				minX: options.bounds.minX + 0.5, maxX: options.bounds.maxX - 0.5,
				minZ: options.bounds.minZ + 0.5, maxZ: options.bounds.maxZ - 0.5
			} : null,
			rimRadius: ( options.rimRadius !== undefined ? options.rimRadius : 4.7 ) - 0.5,
			rimFade: options.rimFade,
			// flowers keep to the flattest ground of the three, proportionally
			maxSlope: options.maxSlope !== undefined ? options.maxSlope * 0.68 : 0.42,
			// tight, high-contrast patches so flowers cluster into clumps rather than
			// dusting evenly across the whole meadow
			patchScale: 1.05,
			patchStrength: 0.92
		} );

		if ( scatter.count === 0 ) return;

		const count = scatter.count;
		const random = makeRandom( 31337 );

		const sizes = new Float32Array( count );
		const flowerIds = new Float32Array( count );

		// The original's flowers stand 0.41-0.51 tall, which was fine for its camera. Ours
		// sits at 0.5 above the ground to get the reference's foreground magnification, so
		// at full size the flowers land exactly at eye level and swallow the frame. In the
		// reference they are small accents, not foreground objects.
		const flowerScale = options.flowerScale !== undefined ? options.flowerScale : 1;
		const atlasCells = Math.max( 1, Math.round(
			options.atlasCells !== undefined ? options.atlasCells : DEFAULT_ATLAS_CELLS
		) );

		for ( let i = 0; i < count; i ++ ) {

			sizes[ i ] = ( FLOWER_SCALE_MIN + random() * FLOWER_SCALE_RANGE ) * flowerScale;
			flowerIds[ i ] = Math.floor( random() * atlasCells );

		}

		// quad pivoted at its base so the stem meets the ground
		const quad = new THREE.PlaneBufferGeometry( 0.3, 0.512 ).translate( 0, 0.256, 0 );

		const geometry = new THREE.InstancedBufferGeometry();
		for ( const name in quad.attributes ) {

			geometry.setAttribute( name, quad.attributes[ name ] );

		}
		geometry.setIndex( quad.getIndex() );

		geometry.setAttribute( 'instancePosition', new THREE.InstancedBufferAttribute( scatter.positions, 3 ) );
		geometry.setAttribute( 'instanceSize', new THREE.InstancedBufferAttribute( sizes, 1 ) );
		geometry.setAttribute( 'flowerId', new THREE.InstancedBufferAttribute( flowerIds, 1 ) );
		geometry.instanceCount = count;

		const mesh = new THREE.Mesh( geometry, new THREE.RawShaderMaterial( {
			uniforms: {
				u_time: this.uniforms.u_time,
				u_texture: { value: texture },
				u_atlasCells: { value: atlasCells },
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
			},
			vertexShader: PRECISION_PREFIX + flowerVert,
			fragmentShader: PRECISION_PREFIX + flowerFrag,
			side: THREE.DoubleSide,
			transparent: true
		} ) );

		mesh.renderOrder = 0;
		mesh.frustumCulled = false;

		this.mesh = mesh;
		this.count = count;
		this.container.add( mesh );

	}

}
