/**
 * Sprite-sheet insects (bee, dragonfly, fly), ported from the original's character
 * system with the storybook scripting stripped out.
 *
 * Each insect is a container Object3D holding one quad. The container carries the
 * world placement; the quad carries the frame animation and the "fly" wander, which is
 * a stack of four incommensurate cosines — no physics, no path, and it never repeats
 * visibly. The magic numbers (42.4, 22.51235, 223.54 …) are the original's.
 */
import * as THREE from '../vendor/three.module.js';
import { PRECISION_PREFIX } from './FboHelper.js';
import { spriteVert, spriteFrag } from './glsl/sprite.js';
import { makeRandom } from './Scatter.js';

export class Insects {

	constructor( uniforms ) {

		this.container = new THREE.Object3D();
		this.uniforms = uniforms;
		this.insects = [];

	}

	/** Loads `<name>.png` + `<name>.json` pairs from assets/textures/characters/. */
	async load( texturePath, names = [ 'bee', 'dragonfly', 'fly' ] ) {

		const textureLoader = new THREE.TextureLoader();
		this.atlases = {};

		await Promise.all( names.map( async name => {

			const base = texturePath + 'characters/' + name;

			const [ data, texture ] = await Promise.all( [
				fetch( base + '.json' ).then( response => {

					if ( ! response.ok ) throw new Error( base + '.json → ' + response.status );
					return response.json();

				} ),
				new Promise( ( resolve, reject ) => {

					const t = textureLoader.load( base + '.png', () => resolve( t ), undefined, reject );
					// atlases are authored top-left origin; the shader flips uv.y itself
					t.flipY = false;
					t.minFilter = THREE.LinearFilter;
					t.magFilter = THREE.LinearFilter;
					t.generateMipmaps = false;

				} )
			] );

			this.atlases[ name ] = { data, texture };

		} ) );

	}

	/**
	 * `placements` is a list of { type, position: [x,y,z], yaw, scale, fps }.
	 * y is interpreted as a height *above the terrain surface*, so insects hover over
	 * whatever hill is loaded.
	 */
	build( surface, placements ) {

		const sample = { y: 0, nx: 0, ny: 1, nz: 0 };
		const random = makeRandom( 8080 );

		placements.forEach( placement => {

			const atlas = this.atlases[ placement.type ];
			if ( ! atlas ) return;

			const [ x, hover, z ] = placement.position;
			const hit = surface.sample( x, z, sample );
			const groundY = hit ? sample.y : 0;

			const holder = new THREE.Object3D();
			holder.position.set( x, groundY + hover, z );
			holder.rotation.y = placement.yaw !== undefined ? placement.yaw : 0;
			holder.scale.setScalar( placement.scale !== undefined ? placement.scale : 0.25 );

			// quad pivoted at its top-left, matching the atlas frame origin
			const quad = new THREE.PlaneBufferGeometry( 1, 1 ).translate( 0.5, - 0.5, 0 );

			const mesh = new THREE.Mesh( quad, new THREE.RawShaderMaterial( {
				uniforms: {
					u_texture: { value: atlas.texture },
					u_textureOffset: { value: new THREE.Vector2() },
					u_textureScale: { value: new THREE.Vector2() },
					u_geometryScale: { value: new THREE.Vector2() },
					u_geometryOffset: { value: new THREE.Vector2() },
					u_hasAlpha: { value: 1 },
					u_envTexture: this.uniforms.u_envTexture,
					u_fogBox: this.uniforms.u_fogBox,
					u_fogRadius: this.uniforms.u_fogRadius,
					u_fogStart: this.uniforms.u_fogStart,
					u_fogRange: this.uniforms.u_fogRange
				},
				vertexShader: PRECISION_PREFIX + spriteVert,
				fragmentShader: PRECISION_PREFIX + spriteFrag,
				side: THREE.DoubleSide,
				transparent: true
			} ) );

			mesh.frustumCulled = false;
			holder.add( mesh );
			this.container.add( holder );

			this.insects.push( {
				holder,
				mesh,
				frames: atlas.data.frames,
				textureWidth: atlas.data.meta.size.w,
				textureHeight: atlas.data.meta.size.h,
				fps: placement.fps !== undefined ? placement.fps : 30,
				strength: placement.strength !== undefined ? placement.strength : 1,
				// desynchronise wingbeats and wander phase
				time: random() * 100
			} );

		} );

	}

	update( dt ) {

		for ( let i = 0; i < this.insects.length; i ++ ) {

			const insect = this.insects[ i ];
			insect.time += dt;

			const frameIndex = Math.floor( insect.time * insect.fps % insect.frames.length );
			const frame = insect.frames[ frameIndex ];

			const uniforms = insect.mesh.material.uniforms;
			const tw = insect.textureWidth;
			const th = insect.textureHeight;

			uniforms.u_textureOffset.value.set( frame.frame.x / tw, frame.frame.y / th );
			uniforms.u_textureScale.value.set( frame.frame.w / tw, frame.frame.h / th );
			uniforms.u_geometryScale.value.set( frame.spriteSourceSize.w, frame.spriteSourceSize.h );
			uniforms.u_geometryOffset.value.set( frame.spriteSourceSize.x, - frame.spriteSourceSize.y );

			// normalise the untrimmed frame to one unit tall, then centre it
			const unit = 1 / frame.sourceSize.h;
			const mesh = insect.mesh;

			mesh.position.set( - 0.5 * frame.sourceSize.w * unit, 0.5 * frame.sourceSize.h * unit, 0 );
			mesh.scale.set( unit, unit, 1 );

			// the original's "fly" action, verbatim
			const strength = insect.strength;
			const t = insect.time / ( 0.5 + 0.5 * strength ) * 2;

			mesh.position.x += Math.cos( 0.85 * t + 42.4 ) / unit * 0.0015 * strength;
			mesh.position.y += Math.sin( 2 * t + 22.51235 ) / unit * 0.00075 * strength;
			mesh.position.y += Math.max( 0, Math.cos( 6 * t + Math.sin( 3 * t ) ) ) / unit * 0.0006 * strength;
			mesh.position.z += Math.cos( 0.75 * t + 223.54 ) / unit * 0.0015 * strength;
			mesh.rotation.x = 0.2 * Math.cos( t + 1.51232 );
			mesh.rotation.z = 0.2 * Math.cos( t + 2.734 );

		}

	}

}
