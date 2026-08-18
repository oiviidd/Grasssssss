/**
 * Minimal fullscreen-pass helper.
 *
 * `quadVert` writes gl_Position straight from the vertex position, so the pass
 * needs no real camera or projection — a bare THREE.Camera and a single
 * screen-covering triangle are enough.
 */
import * as THREE from '../vendor/three.module.js';

const camera = new THREE.Camera();

const geometry = new THREE.BufferGeometry();
geometry.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( [
	- 1, - 1, 0,
	  3, - 1, 0,
	- 1,   3, 0
] ), 3 ) );

const mesh = new THREE.Mesh( geometry );
mesh.frustumCulled = false;

const scene = new THREE.Scene();
scene.add( mesh );

export function createRenderTarget( width = 1, height = 1 ) {

	return new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
		type: THREE.UnsignedByteType,
		depthBuffer: false,
		stencilBuffer: false
	} );

}

export function render( renderer, material, target = null ) {

	mesh.material = material;

	const previousAutoClear = renderer.autoClear;
	renderer.autoClear = false;
	renderer.setRenderTarget( target );
	renderer.render( scene, camera );
	renderer.autoClear = previousAutoClear;

}

export function clearTarget( renderer, target, r, g, b, a ) {

	const previousColor = new THREE.Color();
	const previousAlpha = renderer.getClearAlpha();
	renderer.getClearColor( previousColor );

	renderer.setRenderTarget( target );
	renderer.setClearColor( new THREE.Color( r, g, b ), a );
	renderer.clear( true, false, false );

	renderer.setClearColor( previousColor, previousAlpha );
	renderer.setRenderTarget( null );

}

export const PRECISION_PREFIX = 'precision highp float;\nprecision highp int;\n';
