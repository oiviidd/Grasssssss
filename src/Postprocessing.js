/**
 * Two-pass post chain: bloom, then grade.
 *
 * Both are ports of the original site's effects, including the quirks — see the
 * notes in src/glsl/post.js. The one deliberate omission is the bokeh depth-of-field
 * pass, which sits outside the grass/lighting scope of this study.
 */
import * as THREE from '../vendor/three.module.js';
import { createRenderTarget, render, PRECISION_PREFIX } from './FboHelper.js';
import {
	quadVert,
	bloomHighPassFrag,
	bloomBlurFrag,
	bloomCompositeFrag,
	finalFrag
} from './glsl/post.js';

const ITERATION = 5;

function mix( a, b, t ) {

	return a + ( b - a ) * t;

}

export class Bloom {

	constructor() {

		this.amount = 3.71704;
		this.radius = - 0.13;
		this.threshold = 0.5;
		this.smoothWidth = 1.00155;
		this.haloWidth = 0.8;
		this.haloRGBShift = 0.03;
		this.haloStrength = 0.3;
		this.haloMaskInner = 0.8255;
		this.haloMaskOuter = 1;

		this.directionX = new THREE.Vector2( 1, 0 );
		this.directionY = new THREE.Vector2( 0, 1 );

		this.highPassRenderTarget = createRenderTarget();
		this.renderTargetsHorizontal = [];
		this.renderTargetsVertical = [];
		this.blurMaterials = [];

		for ( let i = 0; i < ITERATION; i ++ ) {

			this.renderTargetsHorizontal.push( createRenderTarget() );
			this.renderTargetsVertical.push( createRenderTarget() );

		}

		const compositeUniforms = {
			u_texture: { value: null },
			u_bloomWeights: { value: new Array( ITERATION ).fill( 0 ) }
		};

		for ( let i = 0; i < ITERATION; i ++ ) {

			compositeUniforms[ 'u_blurTexture' + i ] = { value: this.renderTargetsVertical[ i ].texture };

		}

		this.compositeMaterial = new THREE.RawShaderMaterial( {
			uniforms: compositeUniforms,
			defines: { ITERATION },
			vertexShader: PRECISION_PREFIX + quadVert,
			fragmentShader: PRECISION_PREFIX + bloomCompositeFrag,
			blending: THREE.NoBlending,
			depthTest: false,
			depthWrite: false
		} );

		this.highPassMaterial = new THREE.RawShaderMaterial( {
			uniforms: {
				u_texture: { value: null },
				u_luminosityThreshold: { value: 1 },
				u_smoothWidth: { value: 1 },
				u_haloWidth: { value: 1 },
				u_haloRGBShift: { value: 1 },
				u_haloStrength: { value: 1 },
				u_haloMaskInner: { value: 1 },
				u_haloMaskOuter: { value: 1 },
				u_texelSize: { value: new THREE.Vector2() },
				u_aspect: { value: new THREE.Vector2() }
			},
			vertexShader: PRECISION_PREFIX + quadVert,
			fragmentShader: PRECISION_PREFIX + bloomHighPassFrag,
			blending: THREE.NoBlending,
			depthTest: false,
			depthWrite: false
		} );

		for ( let i = 0; i < ITERATION; i ++ ) {

			const kernelRadius = 3 + 2 * i;

			this.blurMaterials[ i ] = new THREE.RawShaderMaterial( {
				uniforms: {
					u_texture: { value: null },
					u_resolution: { value: new THREE.Vector2() },
					u_direction: { value: this.directionX }
				},
				defines: { KERNEL_RADIUS: kernelRadius, SIGMA: kernelRadius },
				vertexShader: PRECISION_PREFIX + quadVert,
				fragmentShader: PRECISION_PREFIX + bloomBlurFrag,
				blending: THREE.NoBlending,
				depthTest: false,
				depthWrite: false
			} );

		}

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;

		let w = Math.ceil( width / 2 );
		let h = Math.ceil( height / 2 );

		this.highPassRenderTarget.setSize( w, h );

		for ( let i = 0; i < ITERATION; i ++ ) {

			this.renderTargetsHorizontal[ i ].setSize( w, h );
			this.renderTargetsVertical[ i ].setSize( w, h );
			this.blurMaterials[ i ].uniforms.u_resolution.value.set( w, h );

			w = Math.ceil( w / 2 );
			h = Math.ceil( h / 2 );

		}

		this.highPassMaterial.uniforms.u_texelSize.value.set( 1 / width, 1 / height );

		// Same normalisation the vignette uses. Note this caps |toCenter| at 0.5, so
		// with haloMaskInner = 0.8255 the halo term is masked out entirely — exactly
		// as it is on the original site. Kept for fidelity rather than for looks.
		const n = height / Math.sqrt( width * width + height * height );
		this.highPassMaterial.uniforms.u_aspect.value.set( width / height * n, n );

	}

	render( renderer, inputTexture, outputTarget ) {

		const highPass = this.highPassMaterial.uniforms;
		highPass.u_texture.value = inputTexture;
		highPass.u_luminosityThreshold.value = this.threshold;
		highPass.u_smoothWidth.value = this.smoothWidth;
		highPass.u_haloWidth.value = this.haloWidth;
		highPass.u_haloRGBShift.value = this.haloRGBShift * this.width;
		highPass.u_haloStrength.value = this.haloStrength;
		highPass.u_haloMaskInner.value = this.haloMaskInner;
		highPass.u_haloMaskOuter.value = this.haloMaskOuter;

		const useHalo = this.haloStrength > 0;
		if ( this.highPassMaterial.defines.USE_HALO !== useHalo ) {

			this.highPassMaterial.defines.USE_HALO = useHalo;
			this.highPassMaterial.needsUpdate = true;

		}

		render( renderer, this.highPassMaterial, this.highPassRenderTarget );

		let source = this.highPassRenderTarget;

		for ( let i = 0; i < ITERATION; i ++ ) {

			const material = this.blurMaterials[ i ];

			material.uniforms.u_texture.value = source.texture;
			material.uniforms.u_direction.value = this.directionX;
			render( renderer, material, this.renderTargetsHorizontal[ i ] );

			material.uniforms.u_texture.value = this.renderTargetsHorizontal[ i ].texture;
			material.uniforms.u_direction.value = this.directionY;
			render( renderer, material, this.renderTargetsVertical[ i ] );

			source = this.renderTargetsVertical[ i ];

		}

		this.compositeMaterial.uniforms.u_texture.value = inputTexture;

		const weights = this.compositeMaterial.uniforms.u_bloomWeights.value;
		for ( let i = 0; i < ITERATION; i ++ ) {

			const u = ( ITERATION - i ) / ITERATION;
			weights[ i ] = this.amount * mix( u, 1.2 - u, this.radius ) / Math.pow( 2, ITERATION - i - 1 );

		}

		render( renderer, this.compositeMaterial, outputTarget );

	}

}

export class FinalGrade {

	constructor() {

		this.vignetteFrom = 0.47665;
		this.vignetteTo = 1.17146;
		this.vignetteColor = new THREE.Color( 0x0b1f23 );
		this.saturation = 1;
		this.contrast = 0;
		this.brightness = 1;
		this.tintColor = new THREE.Color( 0x05c5e0 );
		this.tintOpacity = 0.30226;
		this.bgColor = new THREE.Color( 0x000000 );
		this.opacity = 1;

		this.material = new THREE.RawShaderMaterial( {
			uniforms: {
				u_texture: { value: null },
				u_bgColor: { value: this.bgColor },
				u_opacity: { value: 1 },
				u_vignetteFrom: { value: 0 },
				u_vignetteTo: { value: 0 },
				u_vignetteAspect: { value: new THREE.Vector2() },
				u_vignetteColor: { value: this.vignetteColor },
				u_saturation: { value: 0 },
				u_contrast: { value: 0 },
				u_brightness: { value: 0 },
				u_tintColor: { value: this.tintColor },
				u_tintOpacity: { value: 0 },
				u_ditherSeed: { value: 0 }
			},
			vertexShader: PRECISION_PREFIX + quadVert,
			fragmentShader: PRECISION_PREFIX + finalFrag,
			blending: THREE.NoBlending,
			depthTest: false,
			depthWrite: false
		} );

	}

	render( renderer, inputTexture, width, height, outputTarget = null ) {

		const u = this.material.uniforms;

		u.u_texture.value = inputTexture;
		u.u_vignetteFrom.value = this.vignetteFrom;
		u.u_vignetteTo.value = this.vignetteTo;
		u.u_vignetteAspect.value
			.set( width / height, 1 )
			.multiplyScalar( height / Math.sqrt( width * width + height * height ) );

		// The presets store these as multipliers around 1; the shader wants offsets.
		u.u_saturation.value = this.saturation - 1;
		u.u_contrast.value = this.contrast;
		u.u_brightness.value = this.brightness - 1;
		u.u_tintOpacity.value = this.tintOpacity;
		u.u_opacity.value = this.opacity;
		u.u_ditherSeed.value = 1000 * Math.random();

		render( renderer, this.material, outputTarget );

	}

}
