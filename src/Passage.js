/**
 * ── PASSAGE ────────────────────────────────────────────────────────────────────
 * The way in and out of the cabin.
 *
 * Outside, the door breathes a thin line of warm light round its gap (and more when the
 * pointer is on it). Clicked, it unlatches and swings out and the room's light pours
 * through; then, with the camera held where it stands, a watercolour wash blooms out of the
 * doorway until the room has the whole screen. Leaving runs it backwards: the wash drains
 * back into the doorway and the door swings shut.
 *
 * The door on the artist's model is painted into the cabin's own mesh, so the leaf that
 * swings is a stand-in: a slab as thick as a real door, whose face is the frame itself,
 * captured at the click (see leafFrag). Where it stood, a "hole" writes alpha 0 into the
 * scene; the composite shows the room in those pixels.
 *
 * Owns: the door meshes (inside the cabin's container), the capture, the targets the meadow
 * and the room are drawn into while both are on screen, and the timeline. main.js owns the
 * render order.
 */

import * as THREE from '../vendor/three.module.js';
import * as FboHelper from './FboHelper.js';
import { quadVert } from './glsl/post.js';
import { doorLightVert, doorLightFrag, leafVert, leafFrag, holeFrag, passageFrag } from './glsl/interior.js';
import { BASE_ZOOM } from './Interior.js';

const LIGHT_COLOR = [ 1.0, 0.66, 0.36 ];

// The door light's strength: at rest, with the pointer on the door, and flaring as it opens.
const GLOW_REST = 1.6;
const GLOW_HOVER = 3.6;
const GLOW_OPEN = 6;

// How far the leaf swings out, and how thick it is: the doorway is 0.365 wide, a door
// about 0.9 m, so 0.022 is a solid 5–6 cm slab of plank door.
const SWING = THREE.MathUtils.degToRad( 80 );
const LEAF_DEPTH = 0.022;

/**
 * The timeline, in seconds from the click. Going in:
 *   unlatch → swing   the leaf gives, then swings out
 *   wash              the watercolour takes the screen, once the door stands open
 *   dry               the room's wash dries back into the painting
 * Coming out runs on its own clock (LEAVE): the wash drains back first, then the door shuts.
 */
const ENTER = {
	unlatch: 0.22,
	swing: [ 0.22, 1.55 ],
	wash: [ 1.15, 3.05 ],
	dry: [ 2.2, 4.6 ],
	done: 3.1
};

const LEAVE = {
	wet: [ 0.0, 0.6 ],
	wash: [ 0.1, 1.9 ],
	close: [ 1.6, 2.8 ],
	done: 2.9
};

const clamp01 = t => Math.min( 1, Math.max( 0, t ) );
const span = ( t, [ a, b ] ) => clamp01( ( t - a ) / ( b - a ) );
const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow( - 2 * t + 2, 3 ) / 2;
const easeInOutSine = t => - ( Math.cos( Math.PI * t ) - 1 ) / 2;
const easeOutCubic = t => 1 - Math.pow( 1 - t, 3 );

/** Adds colour, leaves the alpha as it was — the doorway's 0 must survive what is drawn over it. */
function additiveKeepAlpha( material ) {

	material.transparent = true;
	material.blending = THREE.CustomBlending;
	material.blendEquation = THREE.AddEquation;
	material.blendSrc = THREE.SrcAlphaFactor;
	material.blendDst = THREE.OneFactor;
	material.blendSrcAlpha = THREE.ZeroFactor;
	material.blendDstAlpha = THREE.OneFactor;
	material.depthWrite = false;
	return material;

}

const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _h = new THREE.Matrix3();
const _ndc = new THREE.Vector3();

export class Passage {

	/**
	 * @param interior  the Interior it leads into
	 * @param uniforms  the scene's shared uniforms (for u_time)
	 */
	constructor( interior, uniforms ) {

		this.interior = interior;
		this.uniforms = uniforms;

		this.state = 'outside'; // outside → entering → inside → leaving → outside
		this.time = 0;
		this.hover = false;
		this.glow = GLOW_REST;
		this.reduced = typeof window.matchMedia === 'function' &&
			window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

		this.group = new THREE.Group();
		this.group.name = 'passage';
		this.door = null;
		this.size = new THREE.Vector2( 0.33, 0.78 );

		this.width = 1;
		this.height = 1;
		this.outsideTarget = null;
		this.insideTarget = null;
		this.captureTarget = null;

		this.progress = 0; // the room's share of the screen
		this.open = 0;     // 0..1 of the swing

		this._build();

	}

	/* ── state ───────────────────────────────────────────────────────────────── */

	get busy() {

		return this.state === 'entering' || this.state === 'leaving';

	}

	/** Whether the meadow has to be drawn this frame. */
	get showsOutside() {

		return this.state !== 'inside';

	}

	/** Whether the meadow and the room are both on screen, through compose(). */
	get composing() {

		return this.busy;

	}

	get canEnter() {

		return this.state === 'outside' && !! this.door;

	}

	/* ── the door ────────────────────────────────────────────────────────────── */

	_build() {

		const time = this.uniforms.u_time;

		this.lightMaterial = additiveKeepAlpha( new THREE.ShaderMaterial( {
			uniforms: {
				u_size: { value: this.size },
				u_color: { value: new THREE.Vector3().fromArray( LIGHT_COLOR ) },
				u_intensity: { value: 0 },
				u_time: time
			},
			vertexShader: doorLightVert,
			fragmentShader: doorLightFrag
		} ) );

		this.leafMaterial = new THREE.ShaderMaterial( {
			uniforms: {
				u_capture: { value: null },
				u_captureMatrix: { value: new THREE.Matrix4() },
				u_size: { value: this.size },
				u_depth: { value: LEAF_DEPTH },
				u_light: { value: new THREE.Vector3() },
				u_lightPosition: { value: new THREE.Vector3() }
			},
			vertexShader: leafVert,
			fragmentShader: leafFrag
		} );

		this.holeMaterial = new THREE.ShaderMaterial( {
			vertexShader: doorLightVert,
			fragmentShader: holeFrag,
			blending: THREE.NoBlending
		} );

		this.composeMaterial = new THREE.RawShaderMaterial( {
			uniforms: {
				u_outside: { value: null },
				u_inside: { value: null },
				u_scene: { value: null },
				u_doorFromClip: { value: new THREE.Matrix3() },
				u_doorAspect: { value: new THREE.Vector2( 1, 1 ) },
				u_doorOpen: { value: 0 },
				u_hole: { value: 0 },
				u_lightColor: { value: new THREE.Vector3( 1.0, 0.78, 0.55 ) },
				u_progress: { value: 0 },
				u_origin: { value: new THREE.Vector2( 0.5, 0.5 ) },
				u_aspect: { value: 1 },
				u_time: { value: 0 },
				u_seed: { value: 0 },
				u_resolution: { value: new THREE.Vector2( 1, 1 ) }
			},
			vertexShader: FboHelper.PRECISION_PREFIX + quadVert,
			fragmentShader: FboHelper.PRECISION_PREFIX + passageFrag,
			blending: THREE.NoBlending,
			depthTest: false,
			depthWrite: false
		} );

		this.copyMaterial = new THREE.RawShaderMaterial( {
			uniforms: { u_texture: { value: null } },
			vertexShader: FboHelper.PRECISION_PREFIX + quadVert,
			fragmentShader: FboHelper.PRECISION_PREFIX + `
				uniform sampler2D u_texture;
				varying vec2 v_uv;
				void main() { gl_FragColor = texture2D( u_texture, v_uv ); }
			`,
			blending: THREE.NoBlending,
			depthTest: false,
			depthWrite: false
		} );

	}

	/**
	 * Fits the door meshes to the cabin's door — call after every cabin build. `doorway`
	 * ({ centre, size, frame } in the cabin's own units, see CABIN.doorway) places them on an
	 * artist's model; without it the generated door plane gives the size and the spot.
	 */
	attach( cabin, doorway = null ) {

		this.door = cabin.door;
		if ( this.group.parent ) this.group.parent.remove( this.group );
		this.group.children.slice().forEach( child => {

			this.group.remove( child );
			child.geometry.dispose();

		} );

		if ( ! this.door ) return;

		let frame = 0.01;
		let opening = 0.001;

		if ( doorway ) {

			this.size.fromArray( doorway.size );
			this.group.position.fromArray( doorway.centre );
			this.group.quaternion.identity();
			frame = doorway.frame || frame;
			opening = doorway.opening || opening;

		} else {

			const geometry = this.door.geometry;
			if ( ! geometry.boundingBox ) geometry.computeBoundingBox();
			const box = geometry.boundingBox;
			this.size.set( box.max.x - box.min.x, box.max.y - box.min.y );
			this.group.position.copy( this.door.position );
			this.group.quaternion.copy( this.door.quaternion );

		}

		const w = this.size.x;
		const h = this.size.y;

		cabin.container.add( this.group );

		// The hit target: the door and a margin round it, for a fingertip.
		// The hit target: the door and a margin round it, for a fingertip. Out at the
		// architrave's face, so the frame does not hide it from the ray.
		this.hit = new THREE.Mesh( new THREE.PlaneBufferGeometry( w * 1.35, h * 1.12 ), this.holeMaterial );
		this.hit.position.z = frame + 0.002;
		this.hit.visible = false;
		this.group.add( this.hit );

		// The opening sits just in front of the painted leaf and its handle, and behind the
		// architrave, which frames it as it would a real doorway.
		this.hole = new THREE.Mesh( new THREE.PlaneBufferGeometry( w, h ), this.holeMaterial );
		this.hole.position.z = opening;
		this.hole.visible = false;
		this.group.add( this.hole );

		// Hinged on its left edge. The shot sees the door from the right, so a leaf hinged on
		// the right swung out straight into the line of sight and hid the doorway it had just
		// opened; hinged on the left it swings away and opens the view.
		const leafGeometry = new THREE.BoxBufferGeometry( w, h, LEAF_DEPTH );
		leafGeometry.translate( w / 2, 0, - LEAF_DEPTH / 2 );
		this.leaf = new THREE.Mesh( leafGeometry, this.leafMaterial );
		this.leaf.position.set( - w / 2, 0, opening + 0.002 );
		this.leaf.visible = false;
		this.group.add( this.leaf );

		// The light round the gap is drawn just in front of the architrave, so it reads as
		// leaking past the frame rather than being hidden behind it.
		this.light = new THREE.Mesh( new THREE.PlaneBufferGeometry( w * 1.7, h * 1.3 ), this.lightMaterial );
		this.light.position.z = frame + 0.004;
		this.light.renderOrder = 5;
		this.group.add( this.light );

		this._setOpen( this.state === 'outside' ? 0 : this.open );

	}

	/** The door's centre and outward normal, in world space. */
	doorFrame( centre, normal ) {

		this.group.updateMatrixWorld( true );
		this.group.getWorldPosition( centre );
		normal.set( 0, 0, 1 ).transformDirection( this.group.matrixWorld );
		return this;

	}

	/** The doorway's height in world units. */
	doorHeight() {

		this.group.getWorldScale( _v );
		return this.size.y * _v.y;

	}

	/** True when `raycaster` passes through the door (or close enough to a fingertip). */
	hitTest( raycaster ) {

		if ( ! this.hit ) return false;
		this.hit.updateMatrixWorld();
		return raycaster.intersectObject( this.hit ).length > 0;

	}

	setHover( on ) {

		this.hover = on;

	}

	_setOpen( open ) {

		this.open = open;
		const swinging = this.state !== 'outside' && this.state !== 'inside';
		if ( this.leaf ) {

			this.leaf.rotation.y = - SWING * open; // outward
			this.leaf.visible = swinging;
			this.hole.visible = swinging;

		}

	}

	/* ── going in and coming out ─────────────────────────────────────────────── */

	/**
	 * Captures the frame the leaf takes its face from. `texture` is the scene just rendered
	 * (pre-grade, door light hidden, so neither the light nor the grass in front of the door
	 * gets baked into it), seen by `camera`.
	 */
	capture( renderer, texture, camera ) {

		if ( ! this.captureTarget ) this.captureTarget = FboHelper.createRenderTarget( this.width, this.height );
		this.captureTarget.setSize( this.width, this.height );

		this.copyMaterial.uniforms.u_texture.value = texture;
		FboHelper.render( renderer, this.copyMaterial, this.captureTarget );

		const leaf = this.leaf;
		const angle = leaf.rotation.y;
		leaf.rotation.y = 0;
		leaf.updateMatrixWorld( true );
		_m4.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse ).multiply( leaf.matrixWorld );
		this.leafMaterial.uniforms.u_captureMatrix.value.copy( _m4 );
		this.leafMaterial.uniforms.u_capture.value = this.captureTarget.texture;
		leaf.rotation.y = angle;

	}

	/** Through the door. The camera stays where it is; the door and the wash do the moving. */
	enter() {

		if ( ! this.canEnter ) return false;

		this.state = 'entering';
		this.time = 0;
		this.composeMaterial.uniforms.u_seed.value = Math.random() * 50;
		this.interior.wash = 1;
		this.interior.gust = 1;
		this.interior.zoom = BASE_ZOOM;
		this._setOpen( 0 );
		return true;

	}

	exit() {

		if ( this.state !== 'inside' ) return false;

		this.state = 'leaving';
		this.time = 0;
		this.composeMaterial.uniforms.u_seed.value = Math.random() * 50;
		this._zoomFrom = this.interior.zoom;
		this._setOpen( 1 );
		return true;

	}

	/** Advances the timeline. */
	update( dt ) {

		const interior = this.interior;

		// the door light: breathing at rest, brighter under the pointer, flaring as it opens
		const target = this.state === 'outside' ? ( this.hover ? GLOW_HOVER : GLOW_REST ) : GLOW_OPEN;
		this.glow += ( target - this.glow ) * ( 1 - Math.exp( - dt * 5 ) );
		this.lightMaterial.uniforms.u_intensity.value = this.glow;
		if ( this.light ) this.light.visible = this.state !== 'inside';

		if ( this.state === 'outside' || ! this.door ) return;

		this.time += dt;
		const t = this.time;

		if ( this.state === 'inside' ) {

			interior.gust *= Math.exp( - dt * 0.5 );
			return;

		}

		if ( this.state === 'entering' ) {

			if ( this.reduced ) {

				this.progress = easeInOutSine( clamp01( t / 0.9 ) );
				interior.wash = 0.6 * ( 1 - clamp01( ( t - 0.4 ) / 1.2 ) );
				if ( t >= 1.6 ) this._arrive();
				return;

			}

			// the latch gives a little, then the leaf swings
			const give = Math.sin( clamp01( t / ENTER.unlatch ) * Math.PI ) * 0.035;
			this._setOpen( Math.max( give, easeInOutCubic( span( t, ENTER.swing ) ) ) );

			this.progress = easeInOutSine( span( t, ENTER.wash ) );
			// Seen through the doorway the room is only a little soft; it goes wet as the wash
			// takes the screen, then dries.
			const wet = 0.25 + 0.75 * easeInOutSine( span( t, [ ENTER.wash[ 0 ] - 0.2, ENTER.wash[ 0 ] + 0.4 ] ) );
			interior.wash = wet * ( 1 - easeInOutSine( span( t, ENTER.dry ) ) );
			// the room drifts in a little as it comes, and settles
			interior.zoom = BASE_ZOOM + 0.08 * easeOutCubic( clamp01( ( t - ENTER.wash[ 0 ] ) / 4 ) );

			if ( t >= ENTER.done ) this._arrive();
			return;

		}

		// leaving
		if ( this.reduced ) {

			this.progress = 1 - easeInOutSine( clamp01( t / 0.9 ) );
			interior.wash = 0.6 * clamp01( t / 0.5 );
			if ( t >= 1.0 ) this._leave();
			return;

		}

		interior.wash = Math.max( interior.wash, 0.75 * easeInOutSine( span( t, LEAVE.wet ) ) );
		this.progress = 1 - easeInOutSine( span( t, LEAVE.wash ) );
		interior.zoom = this._zoomFrom + ( BASE_ZOOM - this._zoomFrom ) * easeInOutSine( span( t, LEAVE.wash ) );
		this._setOpen( 1 - easeInOutCubic( span( t, LEAVE.close ) ) );

		if ( t >= LEAVE.done ) this._leave();

	}

	_arrive() {

		this.state = 'inside';
		this.time = 0;
		this.progress = 1;
		this._setOpen( 1 );

	}

	_leave() {

		this.state = 'outside';
		this.time = 0;
		this.progress = 0;
		this.interior.wash = 0;
		this._setOpen( 0 );

	}

	/* ── drawing ─────────────────────────────────────────────────────────────── */

	setSize( width, height ) {

		this.width = Math.max( 1, width );
		this.height = Math.max( 1, height );

		if ( this.outsideTarget ) this.outsideTarget.setSize( this.width, this.height );
		if ( this.insideTarget ) this.insideTarget.setSize( this.width, this.height );
		this.composeMaterial.uniforms.u_resolution.value.set( this.width, this.height );
		this.composeMaterial.uniforms.u_aspect.value = this.width / this.height;

	}

	/** Targets for the two halves of the picture; made on first use, so a visit that never
	 *  opens the door never pays for them. */
	targets() {

		if ( ! this.outsideTarget ) {

			this.outsideTarget = FboHelper.createRenderTarget( this.width, this.height );
			this.insideTarget = FboHelper.createRenderTarget( this.width, this.height );

		}

		return this;

	}

	/** The room's light on the leaf: it comes from just inside the doorway. */
	_lightLeaf() {

		const u = this.leafMaterial.uniforms;
		this.group.updateMatrixWorld( true );
		u.u_lightPosition.value.set( 0, 0, - 0.3 ).applyMatrix4( this.group.matrixWorld );
		u.u_light.value.fromArray( LIGHT_COLOR ).multiplyScalar( 0.35 * this.open );

	}

	/**
	 * Draws the frame from the meadow (graded, in outsideTarget), the room (insideTarget) and
	 * the scene target whose alpha marks the doorway.
	 */
	compose( renderer, sceneTexture, camera ) {

		const u = this.composeMaterial.uniforms;

		u.u_outside.value = this.outsideTarget.texture;
		u.u_inside.value = this.insideTarget.texture;
		u.u_scene.value = sceneTexture;
		u.u_progress.value = this.progress;
		u.u_doorOpen.value = this.open;
		u.u_hole.value = this.hole && this.hole.visible ? 1 : 0;
		u.u_time.value = this.uniforms.u_time.value;

		if ( this.hole ) {

			// The doorway's plane, door uv → clip: columns are its two edges and its corner.
			this.hole.updateMatrixWorld( true );
			_m4.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse ).multiply( this.hole.matrixWorld );
			const w = this.size.x;
			const h = this.size.y;
			const e = _m4.elements;
			const column = ( x, y, z, wv ) => [
				e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z + e[ 12 ] * wv,
				e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z + e[ 13 ] * wv,
				e[ 3 ] * x + e[ 7 ] * y + e[ 11 ] * z + e[ 15 ] * wv
			];
			const a = column( w, 0, 0, 0 );
			const b = column( 0, h, 0, 0 );
			const c = column( - w / 2, - h / 2, 0, 1 );
			_h.set(
				a[ 0 ], b[ 0 ], c[ 0 ],
				a[ 1 ], b[ 1 ], c[ 1 ],
				a[ 2 ], b[ 2 ], c[ 2 ] );
			u.u_doorFromClip.value.getInverse( _h );
			u.u_doorAspect.value.set( w, h );

			// the wash grows out of (and drains back into) the doorway's middle
			this.hole.getWorldPosition( _v );
			_ndc.copy( _v ).project( camera );
			u.u_origin.value.set(
				THREE.MathUtils.clamp( _ndc.x * 0.5 + 0.5, 0, 1 ),
				THREE.MathUtils.clamp( _ndc.y * 0.5 + 0.5, 0, 1 ) );

		}

		FboHelper.render( renderer, this.composeMaterial, null );

	}

	/** Called before the scene is drawn, while the leaf is out. */
	prepare() {

		if ( this.leaf && this.leaf.visible ) this._lightLeaf();

	}

}
