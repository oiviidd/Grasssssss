/**
 * Sprite-sheet insects (bee, dragonfly, fly), ported from the original's character
 * system with the storybook scripting stripped out.
 *
 * Each insect is a container Object3D holding one quad. The container flies: it steers
 * between random waypoints around its home, each species with its own temperament (see
 * FLIGHT). The quad keeps the original's "fly" wobble on top — a stack of incommensurate
 * cosines whose magic numbers (42.4, 22.51235, 223.54 …) are the original's.
 *
 * That wobble was all the original did, and it only ever moves a sprite about a tenth of
 * a unit: every insect hung in one spot buzzing in place rather than crossing the meadow.
 *
 * At dusk (the day / night test, see setPresent) each one breaks off, a beat apart from
 * the others, and flies out past the nearer edge of the frame; at dawn it flies back in
 * from that side to its own patch of meadow and takes up roaming again.
 */
import * as THREE from '../vendor/three.module.js';
import { PRECISION_PREFIX } from './FboHelper.js';
import { spriteVert, spriteFrag } from './glsl/sprite.js';
import { dayNightUniforms } from './glsl/fog.js';
import { makeRandom } from './Scatter.js';

/**
 * How each species moves. Distances are world units, speeds units per second.
 *
 *   roam     radius around its placed position that it ranges over
 *   height   [min, max] above the ground for its waypoints
 *   speed    cruising speed; it slows into each waypoint
 *   agility  how hard it turns onto a new heading — high reads as darting
 *   pause    [min, max] seconds it hangs at a waypoint before moving on
 *   faces    which way the drawing points: 1 right, -1 left, 0 symmetric
 */
const FLIGHT = {
	// hovers dead still, then shoots off
	dragonfly: { roam: 1.7, height: [ 0.22, 0.7 ], speed: 1.1, agility: 6, pause: [ 0.6, 2.4 ], faces: - 1 },
	// meanders low from flower to flower and lingers at each
	bee: { roam: 1.2, height: [ 0.1, 0.42 ], speed: 0.38, agility: 2.2, pause: [ 0.3, 1.4 ], faces: 1 },
	// never settles: short hops, constant changes of mind
	fly: { roam: 0.9, height: [ 0.12, 0.55 ], speed: 0.7, agility: 4.5, pause: [ 0, 0.25 ], faces: 0 }
};

export class Insects {

	constructor( uniforms ) {

		this.container = new THREE.Object3D();
		this.uniforms = uniforms;
		this.insects = [];

		// Out over the meadow, or gone for the night.
		this.present = true;

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
	/*
	 * `avoid` is a list of { position, radius } kept clear of waypoints — the camera, so
	 * nothing flies into the lens, and the cabin, so nothing flies through its walls. The
	 * positions are read live, so they can be objects that move.
	 */
	build( surface, placements, { avoid = [] } = {} ) {

		const sample = { y: 0, nx: 0, ny: 1, nz: 0 };
		const random = makeRandom( 8080 );

		this.surface = surface;
		this.avoid = avoid;
		this.random = random;

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
					u_fogCentre: this.uniforms.u_fogCentre,
					u_fogRadius: this.uniforms.u_fogRadius,
					u_fogStart: this.uniforms.u_fogStart,
					u_fogRange: this.uniforms.u_fogRange,
					u_hazeStart: this.uniforms.u_hazeStart,
					u_hazeRange: this.uniforms.u_hazeRange,
					u_hazeAmount: this.uniforms.u_hazeAmount,
					...dayNightUniforms( this.uniforms )
				},
				vertexShader: PRECISION_PREFIX + spriteVert,
				fragmentShader: PRECISION_PREFIX + spriteFrag,
				side: THREE.DoubleSide,
				transparent: true
			} ) );

			mesh.frustumCulled = false;
			holder.add( mesh );
			this.container.add( holder );

			const flight = FLIGHT[ placement.type ] || FLIGHT.bee;
			const strength = placement.strength !== undefined ? placement.strength : 1;

			this.insects.push( {
				holder,
				mesh,
				flight,
				home: new THREE.Vector2( x, z ),
				roam: flight.roam * strength,
				speed: flight.speed * ( 0.75 + 0.25 * strength ),
				baseScale: holder.scale.x,
				facing: 1,
				// ground x/z plus height *above* the ground, so it follows the hill
				position: new THREE.Vector3( x, hover, z ),
				velocity: new THREE.Vector3(),
				target: new THREE.Vector3( x, hover, z ),
				groundY,
				// starts mid-pause, staggered, so they do not all set off on the same frame
				wait: random() * 1.5,
				leg: 0,
				// roam → leaving → gone → returning → roam; `pending` is a change of state
				// waiting out its `delay`, so the group does not move as one
				state: 'roam',
				pending: null,
				delay: 0,
				exit: new THREE.Vector3(),
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

	/**
	 * Re-reads each solid zone's transform once a frame. A zone is either a circle,
	 * { position, radius }, or a mesh, { object, margin }, whose footprint is its geometry's
	 * bounding box turned and scaled with it — the cabin is a rotated rectangle a good three
	 * units across, and a circle big enough to cover its corners would also fence off half
	 * the meadow in front of it.
	 */
	_refreshZones() {

		for ( const zone of this.avoid ) {

			const object = zone.object;
			if ( ! object ) continue;

			if ( ! object.geometry.boundingBox ) object.geometry.computeBoundingBox();
			object.updateWorldMatrix( true, false );

			zone.box = object.geometry.boundingBox;
			zone.matrix = object.matrixWorld;
			zone.inverse = invert( zone.inverse || new THREE.Matrix4(), object.matrixWorld );
			zone.scale = object.matrixWorld.getMaxScaleOnAxis();

		}

	}

	/** Whether ground point (x, z) lies inside `zone`, grown by `pad`. */
	_inside( zone, x, z, pad = 0 ) {

		if ( zone.radius !== undefined ) {

			return Math.hypot( x - zone.position.x, z - zone.position.z ) < zone.radius + pad;

		}

		if ( ! zone.inverse ) return false;

		// The cabin only turns about y, so the height of the probe does not matter.
		const local = _local.set( x, 0, z ).applyMatrix4( zone.inverse );
		const grow = ( ( zone.margin || 0 ) + pad ) / zone.scale;
		const box = zone.box;

		return local.x > box.min.x - grow && local.x < box.max.x + grow &&
			local.z > box.min.z - grow && local.z < box.max.z + grow;

	}

	_blocked( x, z, pad = 0 ) {

		return this.avoid.some( zone => this._inside( zone, x, z, pad ) );

	}

	/** True when the straight hop from (x0, z0) to (x1, z1) cuts through any zone. */
	_pathBlocked( x0, z0, x1, z1 ) {

		const steps = Math.max( 2, Math.ceil( Math.hypot( x1 - x0, z1 - z0 ) / 0.08 ) );

		for ( let i = 1; i <= steps; i ++ ) {

			const t = i / steps;
			if ( this._blocked( x0 + ( x1 - x0 ) * t, z0 + ( z1 - z0 ) * t, 0.05 ) ) return true;

		}

		return false;

	}

	/**
	 * The hard guarantee. Waypoints and the hops between them are already kept clear, but a
	 * turning insect swings wide of its straight line; anything that strays into a zone is
	 * set back on its edge and loses the part of its velocity heading inward, so it slides
	 * along the wall instead of passing through it.
	 */
	_pushOut( insect ) {

		const { position, velocity } = insect;

		for ( const zone of this.avoid ) {

			if ( ! this._inside( zone, position.x, position.z ) ) continue;

			if ( zone.radius !== undefined ) {

				_normal.set( position.x - zone.position.x, 0, position.z - zone.position.z );
				if ( _normal.lengthSq() < 1e-8 ) _normal.set( 1, 0, 0 );
				_normal.normalize();
				position.x = zone.position.x + _normal.x * zone.radius;
				position.z = zone.position.z + _normal.z * zone.radius;

			} else {

				// out through whichever side of the rectangle is nearest
				const local = _local.set( position.x, 0, position.z ).applyMatrix4( zone.inverse );
				const grow = ( zone.margin || 0 ) / zone.scale;
				const box = zone.box;

				const sides = [
					[ local.x - ( box.min.x - grow ), 'x', box.min.x - grow, - 1 ],
					[ ( box.max.x + grow ) - local.x, 'x', box.max.x + grow, 1 ],
					[ local.z - ( box.min.z - grow ), 'z', box.min.z - grow, - 1 ],
					[ ( box.max.z + grow ) - local.z, 'z', box.max.z + grow, 1 ]
				];

				const [ , axis, edge, sign ] = sides.reduce( ( a, b ) => ( b[ 0 ] < a[ 0 ] ? b : a ) );

				// a hair past the edge, so the next frame does not count it as inside
				local[ axis ] = edge + sign * 1e-3 / zone.scale;
				local.y = 0;
				local.applyMatrix4( zone.matrix );
				position.x = local.x;
				position.z = local.z;

				_normal.set( axis === 'x' ? sign : 0, 0, axis === 'z' ? sign : 0 ).transformDirection( zone.matrix );
				_normal.y = 0;
				_normal.normalize();

			}

			const inward = velocity.x * _normal.x + velocity.z * _normal.z;

			if ( inward < 0 ) {

				velocity.x -= inward * _normal.x;
				velocity.z -= inward * _normal.z;

			}

		}

	}

	/** A new waypoint inside the insect's range, reachable in a straight line clear of `avoid`. */
	_pickTarget( insect ) {

		const { flight, home, roam, target, position } = insect;
		const random = this.random;

		for ( let attempt = 0; attempt < 16; attempt ++ ) {

			const angle = random() * Math.PI * 2;
			const r = roam * Math.sqrt( random() );
			const x = home.x + Math.cos( angle ) * r;
			const z = home.y + Math.sin( angle ) * r;

			// a hop much shorter than its range reads as twitching in place — the old problem
			if ( Math.hypot( x - position.x, z - position.z ) < roam * 0.35 ) continue;
			if ( this._blocked( x, z, 0.1 ) ) continue;
			if ( this._pathBlocked( position.x, position.z, x, z ) ) continue;

			return target.set( x, flight.height[ 0 ] + random() * ( flight.height[ 1 ] - flight.height[ 0 ] ), z );

		}

		// Boxed in: stay where it is and try again after the next pause. Heading home is not
		// safe — a home that a moved cabin now covers would pin it against the wall.
		return target.copy( position );

	}

	/**
	 * Sends the insects off (false) or brings them back (true). Each goes on its own short
	 * delay; one still on its way out simply turns round.
	 */
	setPresent( present ) {

		if ( present === this.present ) return;
		this.present = present;

		for ( const insect of this.insects ) {

			insect.pending = present ? 'return' : 'leave';
			insect.delay = this.random() * ( present ? 2.5 : 1.6 );

		}

	}

	/**
	 * A point just past the side of the frame nearer to (x, z), at the same depth, that a
	 * straight flight from there reaches without crossing the cabin. Over the top when
	 * both sides are blocked.
	 */
	_exitFor( x, z, height, camera ) {

		_forward.set( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
		_forward.y = 0;
		if ( _forward.lengthSq() < 1e-6 ) _forward.set( 0, 0, - 1 );
		_forward.normalize();
		_right.set( - _forward.z, 0, _forward.x );

		const dx = x - camera.position.x;
		const dz = z - camera.position.z;
		const depth = Math.max( 1, dx * _forward.x + dz * _forward.z );
		const across = dx * _right.x + dz * _right.z;

		const halfHeight = THREE.MathUtils.degToRad( camera.fov ) * 0.5;
		const edge = Math.tan( halfHeight ) * camera.aspect * depth;

		const nearer = across >= 0 ? 1 : - 1;

		for ( const side of [ nearer, - nearer ] ) {

			// well clear of the edge, so the sprite is fully out before it stops
			const out = side * ( edge + 1.2 );
			const ex = camera.position.x + _forward.x * ( depth + 0.8 ) + _right.x * out;
			const ez = camera.position.z + _forward.z * ( depth + 0.8 ) + _right.z * out;

			if ( ! this._pathBlocked( x, z, ex, ez ) ) return _exit.set( ex, height + 0.6, ez );

		}

		return _exit.set( x, height + Math.tan( halfHeight ) * depth * 1.6 + 1, z );

	}

	_startLeaving( insect, camera ) {

		const { position } = insect;
		insect.exit.copy( this._exitFor( position.x, position.z, position.y, camera ) );
		insect.target.copy( insect.exit );
		insect.state = 'leaving';
		insect.wait = 0;
		insect.leg = 0;

	}

	_startReturning( insect, camera ) {

		const { home, flight, position } = insect;
		const height = flight.height[ 0 ] + this.random() * ( flight.height[ 1 ] - flight.height[ 0 ] );

		// Still in view, heading out: turn round where it is. Otherwise come in from the side
		// nearer its patch of meadow.
		if ( insect.state === 'gone' ) {

			position.copy( this._exitFor( home.x, home.y, height, camera ) );
			insect.velocity.set( 0, 0, 0 );
			insect.holder.visible = true;

		}

		insect.target.set( home.x, height, home.y );
		insect.state = 'returning';
		insect.wait = 0;
		insect.leg = 0;

	}

	_fly( insect, dt, camera ) {

		const { flight, position, velocity, target } = insect;

		if ( insect.pending ) {

			insect.delay -= dt;

			if ( insect.delay <= 0 && camera ) {

				if ( insect.pending === 'leave' && insect.state !== 'gone' ) this._startLeaving( insect, camera );
				else if ( insect.pending === 'return' && insect.state !== 'roam' ) this._startReturning( insect, camera );
				insect.pending = null;

			}

		}

		if ( insect.state === 'gone' ) return;

		if ( insect.state === 'leaving' || insect.state === 'returning' ) {

			// A purposeful flight: quicker than its roaming, straight to the point.
			_toTarget.subVectors( target, position );
			const distance = _toTarget.length();
			insect.leg += dt;

			if ( distance < 0.12 || insect.leg > 14 ) {

				if ( insect.state === 'leaving' ) {

					insect.state = 'gone';
					insect.holder.visible = false;
					velocity.set( 0, 0, 0 );
					return;

				}

				insect.state = 'roam';
				const [ lo, hi ] = flight.pause;
				insect.wait = Math.max( 1e-3, lo + this.random() * ( hi - lo ) );

			} else {

				const hurry = Math.max( insect.speed * 2.2, 0.9 );
				const slowing = insect.state === 'returning' ? Math.min( 1, distance / ( hurry * 0.6 ) ) : 1;
				_toTarget.multiplyScalar( hurry * slowing / distance );
				velocity.lerp( _toTarget, Math.min( 1, flight.agility * 0.6 * dt ) );

			}

		} else if ( insect.wait > 0 ) {

			insect.wait -= dt;
			velocity.multiplyScalar( Math.max( 0, 1 - dt * 6 ) );

			if ( insect.wait <= 0 ) {

				this._pickTarget( insect );
				insect.leg = 0;

			}

		} else {

			_toTarget.subVectors( target, position );
			const distance = _toTarget.length();
			insect.leg += dt;

			// Arrived — or has been chasing this one too long, so give up and choose again.
			if ( distance < 0.04 || insect.leg > 8 ) {

				const [ lo, hi ] = flight.pause;
				insect.wait = Math.max( 1e-3, lo + this.random() * ( hi - lo ) );

			} else {

				// slows into the waypoint rather than overshooting and circling it
				const cruise = insect.speed * Math.min( 1, distance / ( insect.speed * 0.6 ) );
				_toTarget.multiplyScalar( cruise / distance );
				velocity.lerp( _toTarget, Math.min( 1, flight.agility * dt ) );

			}

		}

		position.addScaledVector( velocity, dt );
		this._pushOut( insect );

		// follows the hill under it; off the terrain it holds the last ground height
		if ( this.surface && this.surface.sample( position.x, position.z, _sample ) ) insect.groundY = _sample.y;

		insect.holder.position.set( position.x, insect.groundY + position.y, position.z );

	}

	update( dt, camera ) {

		this._refreshZones();

		for ( let i = 0; i < this.insects.length; i ++ ) {

			const insect = this.insects[ i ];
			insect.time += dt;

			this._fly( insect, dt, camera );
			if ( insect.state === 'gone' ) continue;

			// A flat drawing seen edge-on vanishes, so it turns to face the camera, and is
			// mirrored to point the way it is flying. The threshold stops it flipping back
			// and forth while it hovers.
			if ( camera ) {

				const holder = insect.holder;
				const yaw = Math.atan2( camera.position.x - holder.position.x, camera.position.z - holder.position.z );
				holder.rotation.y = yaw;

				if ( insect.flight.faces ) {

					const across = insect.velocity.x * Math.cos( yaw ) - insect.velocity.z * Math.sin( yaw );
					if ( Math.abs( across ) > 0.05 ) insect.facing = Math.sign( across ) * insect.flight.faces;

				}

				holder.scale.set( insect.baseScale * insect.facing, insect.baseScale, insect.baseScale );

			}

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

const _toTarget = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _exit = new THREE.Vector3();
const _sample = { y: 0, nx: 0, ny: 1, nz: 0 };
const _local = new THREE.Vector3();
const _normal = new THREE.Vector3();

// three renamed Matrix4.getInverse(m) to m.invert() partway through the r12x series.
function invert( target, matrix ) {

	return typeof target.invert === 'function' ? target.copy( matrix ).invert() : target.getInverse( matrix );

}
