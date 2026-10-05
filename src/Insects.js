/**
 * Sprite-sheet insects (bee, dragonfly, fly), ported from the original's character
 * system with the storybook scripting stripped out.
 *
 * Each insect is a container Object3D holding one quad. The container flies; the quad
 * keeps the original's "fly" wobble on top — a stack of incommensurate cosines whose magic
 * numbers (42.4, 22.51235, 223.54 …) are the original's.
 *
 * How it flies is a string of manoeuvres, each species drawing from its own mix (FLIGHT):
 *
 *   hover    hangs in the air, drifting a little       dart    a quick straight run
 *   cruise   a winding flight to somewhere new         zigzag  a few legs, side to side
 *   orbit    circles a point on a tilted ring          figure8 a lazy figure-eight
 *   dip      drops down to the flowers and rests there a moment
 *
 * It replaced plain waypoints: fly straight to a point, stop, wait, pick another. Every
 * insect then moved like the same machine at a different speed.
 *
 * On top of the path, the sprite banks into its turns, leans into its speed, and beats its
 * wings faster the harder it is working. Clicked or tapped (startle), it flinches and bolts
 * away from the finger in a climbing zigzag, then settles and wanders back.
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
 *   height   [min, max] above the ground it keeps to
 *   speed    cruising speed
 *   agility  how hard it turns onto a new heading — high reads as darting
 *   hover    [min, max] seconds a hover lasts
 *   drift    how far a hover wanders, as a speed
 *   weave    how much a cruise snakes from side to side, as a share of its speed
 *   ring     [min, max] radius of its orbits and figure-eights
 *   moves    how often it picks each manoeuvre, relative to the others
 *   flee     how much faster than its cruise it bolts when startled
 *   faces    which way the drawing points: 1 right, -1 left, 0 symmetric
 */
//
// Tuned for calm. A first pass had tight rings at seven radians a second, quarter-second
// zigzags and darts at nearly three times cruising speed, and the meadow read as frantic —
// the variety belongs in *which* manoeuvre comes next, not in how hard each one is flown.
const FLIGHT = {
	// hangs still for a long while, glides off, now and then a short dash
	dragonfly: {
		roam: 1.7, height: [ 0.22, 0.7 ], speed: 1.1, agility: 4, hover: [ 1.2, 3.2 ], drift: 0.02, weave: 0.08,
		ring: [ 0.35, 0.6 ], flee: 3.2, faces: - 1,
		moves: { hover: 3, cruise: 2.5, dart: 1, orbit: 0.8, zigzag: 0.3 }
	},
	// drifts low from flower to flower, loops lazily round some, settles on others
	bee: {
		roam: 1.2, height: [ 0.1, 0.42 ], speed: 0.38, agility: 2, hover: [ 0.8, 2 ], drift: 0.04, weave: 0.22,
		ring: [ 0.2, 0.35 ], flee: 3.6, faces: 1,
		moves: { cruise: 3, dip: 1.5, hover: 1.2, orbit: 1, figure8: 0.8 }
	},
	// restless but not frantic: wanders, circles, changes its mind
	fly: {
		roam: 0.9, height: [ 0.12, 0.55 ], speed: 0.6, agility: 3, hover: [ 0.4, 1.1 ], drift: 0.06, weave: 0.18,
		ring: [ 0.15, 0.28 ], flee: 3, faces: 0,
		moves: { cruise: 2.5, hover: 1.5, orbit: 1.2, zigzag: 0.8, dart: 0.4 }
	}
};

// Lowest an insect goes above the ground, a bee resting on a flower included.
const MIN_HEIGHT = 0.04;

// How hard the wings beat, as a multiple of the sheet's fps, in each manoeuvre.
const EFFORT = { hover: 0.9, cruise: 1, dart: 1.25, zigzag: 1.1, orbit: 1.05, figure8: 1.05, dip: 1, rest: 0.5, flee: 1.9 };

// Fastest a ring is flown, in radians a second: a full turn takes three seconds or more.
const RING_RATE = 2.1;

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
				// the manoeuvre under way (see _nextMove); a start-up hover of its own length,
				// so they do not all set off on the same frame
				move: { kind: 'hover', time: 0, duration: random() * 1.5, done: false, effort: EFFORT.hover },
				previous: 'hover',
				leg: 0,
				// what the sprite is doing on top of the path: wingbeat rate, roll, a flinch
				effort: 1,
				frameTime: random() * 100,
				roll: 0,
				across: 0,
				flinch: 0,
				flee: null,
				phase: random() * 100,
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

	/**
	 * A new waypoint inside the insect's range, reachable in a straight line clear of `avoid`,
	 * between `near` and `far` away. Returns false when boxed in, leaving the target on the
	 * insect itself. Heading home instead is not safe — a home that a moved cabin now covers
	 * would pin it against the wall.
	 */
	_pickTarget( insect, { near = insect.roam * 0.35, far = Infinity, height = insect.flight.height } = {} ) {

		const { home, roam, target, position } = insect;
		const random = this.random;

		for ( let attempt = 0; attempt < 16; attempt ++ ) {

			const angle = random() * Math.PI * 2;
			const r = roam * Math.sqrt( random() );
			const x = home.x + Math.cos( angle ) * r;
			const z = home.y + Math.sin( angle ) * r;

			// a hop much shorter than its range reads as twitching in place — the old problem
			const hop = Math.hypot( x - position.x, z - position.z );
			if ( hop < near || hop > far ) continue;
			if ( this._blocked( x, z, 0.1 ) ) continue;
			if ( this._pathBlocked( position.x, position.z, x, z ) ) continue;

			target.set( x, height[ 0 ] + random() * ( height[ 1 ] - height[ 0 ] ), z );
			return true;

		}

		target.copy( position );
		return false;

	}

	/** Whether ground point (x, z) is somewhere this insect may be: in its range, clear of `avoid`. */
	_open( insect, x, z, slack = 1.3 ) {

		return Math.hypot( x - insect.home.x, z - insect.home.y ) < insect.roam * slack && ! this._blocked( x, z, 0.08 );

	}

	/** One of the species' manoeuvres, by its weights, not the same one twice running. */
	_chooseKind( insect ) {

		const moves = insect.flight.moves;
		let total = 0;
		for ( const kind in moves ) if ( kind !== insect.previous || kind === 'hover' ) total += moves[ kind ];

		let pick = this.random() * total;
		for ( const kind in moves ) {

			if ( kind === insect.previous && kind !== 'hover' ) continue;
			pick -= moves[ kind ];
			if ( pick <= 0 ) return kind;

		}

		return 'hover';

	}

	/**
	 * Starts the next manoeuvre. `kind` forces one; a manoeuvre that has no room to happen
	 * where the insect is falls back to a cruise, which always finds somewhere to go.
	 */
	_nextMove( insect, kind = this._chooseKind( insect ) ) {

		const random = this.random;
		const { flight, position } = insect;
		const move = insect.move;

		move.kind = kind;
		move.time = 0;
		move.done = false;
		move.effort = EFFORT[ kind ];
		// a little variety in pace from one manoeuvre to the next
		move.pace = insect.speed * ( 0.85 + random() * 0.25 );

		insect.previous = kind;
		insect.leg = 0;

		const between = ( [ lo, hi ] ) => lo + random() * ( hi - lo );

		if ( kind === 'hover' ) {

			move.duration = between( flight.hover );
			return move;

		}

		if ( kind === 'dart' ) {

			// somewhere a good way off, so the dash reads as a dash
			if ( ! this._pickTarget( insect, { near: 0.5, far: 1.5 } ) ) return this._nextMove( insect, 'cruise' );
			move.duration = 3;
			return move;

		}

		if ( kind === 'zigzag' ) {

			this._pickTarget( insect, { near: 0.3 } );
			move.heading = Math.atan2( insect.target.z - position.z, insect.target.x - position.x );
			move.segments = 3 + Math.floor( random() * 4 );
			move.segment = - 1;
			move.segmentTime = 0;
			move.side = random() < 0.5 ? - 1 : 1;
			move.duration = 4;
			return move;

		}

		if ( kind === 'orbit' || kind === 'figure8' ) {

			if ( this._planRing( insect, move, kind ) ) return move;
			return this._nextMove( insect, 'cruise' );

		}

		if ( kind === 'dip' ) {

			// down among the flowers, close by
			const low = [ 0.05, 0.1 ];
			if ( ! this._pickTarget( insect, { near: 0.12, far: 0.6, height: low } ) ) return this._nextMove( insect, 'cruise' );
			move.rest = between( [ 0.8, 2.2 ] );
			move.landed = false;
			move.duration = 12;
			return move;

		}

		// cruise
		this._pickTarget( insect );
		move.weave = flight.weave * ( 0.5 + random() * 0.7 );
		move.weaveRate = 0.8 + random() * 0.9;
		move.weavePhase = random() * Math.PI * 2;
		move.duration = 9;
		return move;

	}

	/**
	 * Lays out an orbit or a figure-eight round a point beside the insect, on a ring tipped up
	 * out of the ground plane so the loop shows from a low camera. False when the ring would
	 * leave its range, cross the cabin or dip into the grass.
	 */
	_planRing( insect, move, kind ) {

		const random = this.random;
		const { flight, position } = insect;
		const radius = flight.ring[ 0 ] + random() * ( flight.ring[ 1 ] - flight.ring[ 0 ] );
		const heading = random() * Math.PI * 2;
		const tilt = 0.25 + random() * 0.7;

		move.radius = radius;
		move.axisA = ( move.axisA || new THREE.Vector3() ).set( Math.cos( heading ), 0, Math.sin( heading ) );
		move.axisB = ( move.axisB || new THREE.Vector3() ).set( - Math.sin( heading ) * Math.cos( tilt ), Math.sin( tilt ), Math.cos( heading ) * Math.cos( tilt ) );
		move.direction = random() < 0.5 ? - 1 : 1;
		move.start = random() * Math.PI * 2;
		// a little under its own pace along the ring, and never a blur
		move.rate = Math.min( RING_RATE, move.pace * 0.9 / radius );
		const laps = kind === 'orbit' ? 0.8 + random() * 0.8 : 1;
		move.duration = laps * Math.PI * 2 / move.rate;

		// centred so the ring passes through the insect where it is now
		move.centre = ( move.centre || new THREE.Vector3() ).copy( position ).sub( this._ringPoint( move, kind, move.start, _ring ) );

		// lifted clear of the grass if its lowest point would graze it
		const lowest = move.centre.y - radius * Math.sin( tilt ) * ( kind === 'orbit' ? 1 : 0.7 );
		if ( lowest < flight.height[ 0 ] * 0.6 ) move.centre.y += flight.height[ 0 ] * 0.6 - lowest;

		for ( let i = 0; i < 8; i ++ ) {

			const p = this._ringPoint( move, kind, i / 8 * Math.PI * 2, _ring ).add( move.centre );
			if ( ! this._open( insect, p.x, p.z ) ) return false;

		}

		return true;

	}

	/** The offset from the ring's centre at angle `angle`: a circle, or Gerono's figure-eight. */
	_ringPoint( move, kind, angle, out ) {

		const r = move.radius;
		const a = Math.cos( angle );
		const b = kind === 'orbit' ? Math.sin( angle ) : Math.sin( angle ) * Math.cos( angle ) * 1.4;

		return out.copy( move.axisA ).multiplyScalar( a * r ).addScaledVector( move.axisB, b * r );

	}

	/** The ring's direction of travel at `angle`, per radian. */
	_ringTangent( move, kind, angle, out ) {

		const r = move.radius;
		const a = - Math.sin( angle );
		const b = kind === 'orbit' ? Math.cos( angle ) : Math.cos( 2 * angle ) * 1.4;

		return out.copy( move.axisA ).multiplyScalar( a * r ).addScaledVector( move.axisB, b * r );

	}

	/**
	 * This frame's wanted velocity for the manoeuvre under way, into `_desired`, and how hard
	 * to turn onto it. Marks the manoeuvre done when it has run its course.
	 */
	_roam( insect, dt ) {

		const { flight, position, target } = insect;
		let move = insect.move;

		if ( move.done ) move = this._nextMove( insect );

		move.time += dt;
		insect.leg += dt;

		const t = insect.time + insect.phase;
		let agility = flight.agility;

		switch ( move.kind ) {

			case 'hover': {

				// a slow, uneven drift about the spot, and a bob
				const d = flight.drift;
				_desired.set(
					Math.sin( t * 1.7 ) * d + Math.sin( t * 0.63 + 2 ) * d * 0.6,
					Math.sin( t * 2.3 + 1 ) * d * 0.8,
					Math.sin( t * 1.3 + 4 ) * d + Math.sin( t * 0.71 ) * d * 0.6
				);
				agility *= 0.8;
				if ( move.time >= move.duration ) move.done = true;
				break;

			}

			case 'cruise': {

				_toTarget.subVectors( target, position );
				const distance = _toTarget.length();

				if ( distance < 0.05 || move.time > move.duration ) {

					move.done = true;
					_desired.copy( insect.velocity ).multiplyScalar( 0.5 );
					break;

				}

				// slows into the waypoint rather than overshooting and circling it, and snakes
				// side to side on the way: the weave fades out as it arrives
				const cruise = move.pace * Math.min( 1, distance / Math.max( move.pace, 0.25 ) );
				_desired.copy( _toTarget ).multiplyScalar( cruise / distance );
				_side.set( - _toTarget.z, 0, _toTarget.x ).normalize();
				const weave = Math.sin( move.time * move.weaveRate + move.weavePhase ) * move.weave * cruise;
				_desired.addScaledVector( _side, weave );
				_desired.y += Math.sin( move.time * move.weaveRate * 1.7 ) * cruise * 0.25;
				break;

			}

			case 'dart': {

				_toTarget.subVectors( target, position );
				const distance = _toTarget.length();

				if ( distance < 0.06 || move.time > move.duration ) {

					// stops dead and hangs there
					this._nextMove( insect, 'hover' );
					_desired.set( 0, 0, 0 );
					break;

				}

				// quick, but eased in and out — a glide with intent, not a teleport
				const dash = move.pace * 1.8 * Math.min( 1, distance / 0.3 );
				_desired.copy( _toTarget ).multiplyScalar( dash / distance );
				agility = 6;
				break;

			}

			case 'zigzag': {

				// a run of short legs, each kicked off to alternate sides of the general heading
				move.segmentTime -= dt;

				if ( move.segmentTime <= 0 ) {

					move.segment ++;

					if ( move.segment >= move.segments ) {

						move.done = true;
						_desired.copy( insect.velocity ).multiplyScalar( 0.3 );
						break;

					}

					// strayed past its range: swing the general heading back toward home
					if ( ! this._open( insect, position.x, position.z, 1 ) ) {

						move.heading = Math.atan2( insect.home.y - position.z, insect.home.x - position.x );

					}

					move.side = - move.side;
					move.segmentTime = 0.4 + this.random() * 0.35;
					move.angle = move.heading + move.side * ( 0.3 + this.random() * 0.3 );
					move.climb = ( this.random() - 0.5 ) * 0.3;

				}

				const speed = move.pace * 1.15;
				_desired.set( Math.cos( move.angle ) * speed, move.climb * speed, Math.sin( move.angle ) * speed );
				agility = 4;
				break;

			}

			case 'orbit':
			case 'figure8': {

				if ( move.time >= move.duration ) {

					move.done = true;
					_desired.copy( insect.velocity );
					break;

				}

				// chases its point round the ring, so it never cuts a corner off the shape
				const angle = move.start + move.direction * move.rate * move.time;
				const p = this._ringPoint( move, move.kind, angle, _ring ).add( move.centre );
				this._ringTangent( move, move.kind, angle, _desired ).multiplyScalar( move.direction * move.rate );
				_desired.addScaledVector( p.sub( position ), 2.5 );
				agility = Math.max( agility, 4 );
				break;

			}

			case 'dip': {

				_toTarget.subVectors( target, position );
				const distance = _toTarget.length();

				if ( ! move.landed ) {

					if ( distance < 0.03 || move.time > move.duration ) {

						move.landed = true;
						move.time = 0;
						move.effort = EFFORT.rest;

					}

					const descend = move.pace * 0.75 * Math.min( 1, distance / ( move.pace * 0.5 ) );
					_desired.copy( _toTarget ).multiplyScalar( descend / Math.max( distance, 1e-4 ) );

				} else {

					// settled among the flowers: barely moving, wings slow, a shuffle now and then
					_desired.set( Math.sin( t * 0.9 ) * 0.01, Math.sin( t * 1.9 ) * 0.006, Math.sin( t * 0.7 + 1 ) * 0.01 );
					_desired.addScaledVector( _toTarget, 2 );
					if ( move.time >= move.rest ) move.done = true;

				}

				break;

			}

		}

		// out of a flee or a dusk flight it may be well off its heights: ease back between them
		if ( move.kind !== 'dip' ) {

			const [ lo, hi ] = flight.height;
			if ( position.y < lo * 0.6 ) _desired.y += ( lo * 0.6 - position.y ) * 3;
			else if ( position.y > hi * 1.25 ) _desired.y -= ( position.y - hi * 1.25 ) * 1.5;

		}

		return agility;

	}

	/** Bolting from a tap: fast, climbing, jinking every fraction of a second, then winding down. */
	_bolt( insect, dt ) {

		const flee = insect.flee;
		flee.time += dt;
		flee.jink -= dt;

		if ( flee.jink <= 0 ) {

			// each jink swings off the escape line, but never back toward the threat
			flee.jink = 0.18 + this.random() * 0.2;
			flee.offset = ( this.random() - 0.5 ) * 0.9;

		}

		const heading = flee.heading + flee.offset;
		const ease = 1 - Math.max( 0, ( flee.time - flee.duration * 0.55 ) / ( flee.duration * 0.45 ) );
		const speed = flee.speed * ( 0.35 + 0.65 * ease );

		_desired.set( Math.cos( heading ) * speed, flee.climb * ease, Math.sin( heading ) * speed );

		if ( flee.time >= flee.duration ) {

			// catches its breath, then back to its usual round
			insect.flee = null;
			insect.state = 'roam';
			this._nextMove( insect, 'hover' );
			insect.move.duration = 0.6 + this.random() * 0.8;

		}

		return 8;

	}

	/**
	 * Sends the insects off (false) or brings them back (true). Each goes on its own short
	 * delay; one still on its way out simply turns round.
	 */
	setPresent( present, { immediate = false } = {} ) {

		if ( present === this.present ) return;
		this.present = present;

		for ( const insect of this.insects ) {

			// A page that opens at night starts with the meadow already empty, rather than
			// watching every insect leave in its first seconds.
			if ( immediate ) {

				insect.state = present ? 'roam' : 'gone';
				insect.pending = null;
				insect.flee = null;
				insect.velocity.set( 0, 0, 0 );
				insect.holder.visible = present;
				continue;

			}

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
		insect.flee = null;
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
		insect.flee = null;
		insect.leg = 0;

	}

	/**
	 * The insect under a screen point (CSS pixels), or null: whichever sprite centre is
	 * nearest, within the larger of its own drawn radius and `slop` — a fingertip is far
	 * bigger than a fly.
	 */
	pick( x, y, camera, width, height, slop = 20 ) {

		let best = null;
		let bestDistance = Infinity;

		// pixels per world unit at depth 1, the lens shift and zoom included
		const focal = camera.projectionMatrix.elements[ 5 ] * height * 0.5;

		for ( const insect of this.insects ) {

			if ( insect.state === 'gone' || ! insect.holder.visible ) continue;

			const ndc = _screen.copy( insect.holder.position ).project( camera );
			if ( ndc.z > 1 || ndc.z < - 1 ) continue;

			const sx = ( ndc.x + 1 ) * 0.5 * width;
			const sy = ( 1 - ndc.y ) * 0.5 * height;
			const depth = _screen.copy( insect.holder.position ).applyMatrix4( camera.matrixWorldInverse ).z * - 1;
			if ( depth <= 0 ) continue;

			const radius = Math.max( insect.baseScale * 0.45 * focal / depth, slop );
			const distance = Math.hypot( x - sx, y - sy );

			if ( distance < radius && distance < bestDistance ) {

				best = insect;
				bestDistance = distance;

			}

		}

		return best;

	}

	/**
	 * A tap on the insect: it flinches, then bolts directly away from the finger across the
	 * screen, deeper into the meadow and up. Only while it is out roaming — one already
	 * leaving for the night keeps going.
	 */
	startle( insect, x, y, camera, width, height ) {

		if ( insect.state !== 'roam' && insect.state !== 'flee' ) return false;

		// where the tap was relative to the insect, on screen
		const ndc = _screen.copy( insect.holder.position ).project( camera );
		let dx = ( ndc.x + 1 ) * 0.5 * width - x;
		let dy = ( 1 - ndc.y ) * 0.5 * height - y;
		const length = Math.hypot( dx, dy );

		// dead centre: away to either side
		if ( length < 4 ) {

			dx = this.random() < 0.5 ? - 1 : 1;
			dy = - 0.3;

		} else {

			dx /= length;
			dy /= length;

		}

		_forward.set( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
		_forward.y = 0;
		if ( _forward.lengthSq() < 1e-6 ) _forward.set( 0, 0, - 1 );
		_forward.normalize();
		_right.set( - _forward.z, 0, _forward.x );

		// away across the screen, and away from the lens
		_side.copy( _right ).multiplyScalar( dx ).addScaledVector( _forward, 0.55 ).normalize();

		const flight = insect.flight;
		const speed = Math.max( insect.speed * flight.flee, 1.3 );

		insect.state = 'flee';
		insect.flee = {
			time: 0,
			duration: 1.2 + this.random() * 0.8,
			heading: Math.atan2( _side.z, _side.x ),
			offset: 0,
			jink: 0.08,
			speed,
			// up, more so when the finger came from below
			climb: speed * ( 0.14 + Math.max( 0, - dy ) * 0.18 )
		};

		// the jolt: off the mark before the steering has even turned
		insect.velocity.addScaledVector( _side, speed * 0.6 );
		insect.velocity.y += speed * 0.2;
		insect.flinch = 1;

		return true;

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
				this._nextMove( insect, 'hover' );

			} else {

				const hurry = Math.max( insect.speed * 2.2, 0.9 );
				const slowing = insect.state === 'returning' ? Math.min( 1, distance / ( hurry * 0.6 ) ) : 1;
				_toTarget.multiplyScalar( hurry * slowing / distance );
				velocity.lerp( _toTarget, Math.min( 1, flight.agility * 0.6 * dt ) );

			}

			insect.effort += ( 1.3 - insect.effort ) * Math.min( 1, dt * 4 );

		} else {

			const fleeing = insect.state === 'flee';
			const agility = fleeing ? this._bolt( insect, dt ) : this._roam( insect, dt );
			velocity.lerp( _desired, Math.min( 1, agility * dt ) );

			const effort = fleeing ? EFFORT.flee : insect.move.effort;
			insect.effort += ( effort - insect.effort ) * Math.min( 1, dt * ( fleeing ? 6 : 2 ) );

		}

		position.addScaledVector( velocity, dt );
		this._pushOut( insect );

		// A ring or a jink can carry it lower than it meant to go; it never goes into the
		// ground. (Too high is only ever eased down, in _roam: one that has bolted up out of
		// frame has to glide back, not drop.)
		if ( position.y < MIN_HEIGHT ) {

			position.y = MIN_HEIGHT;
			velocity.y = Math.max( 0, velocity.y );

		}

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
			//
			// `tilt` is what the body does on top of the path, as an angle on screen
			// (anticlockwise up): it banks into a turn, dips its nose as it speeds up and lifts
			// it as it climbs.
			let tilt = 0;

			if ( camera ) {

				const holder = insect.holder;
				const yaw = Math.atan2( camera.position.x - holder.position.x, camera.position.z - holder.position.z );
				holder.rotation.y = yaw;

				const across = insect.velocity.x * Math.cos( yaw ) - insect.velocity.z * Math.sin( yaw );

				if ( insect.flight.faces ) {

					if ( Math.abs( across ) > 0.05 ) insect.facing = Math.sign( across ) * insect.flight.faces;

				}

				holder.scale.set( insect.baseScale * insect.facing, insect.baseScale, insect.baseScale );

				const swerve = dt > 0 ? ( across - insect.across ) / dt : 0;
				insect.across = across;

				// a gentle lean, not an aerobatic one
				const pace = Math.max( insect.speed, 0.2 );
				const bank = - THREE.MathUtils.clamp( swerve * 0.03 / pace, - 0.22, 0.22 );
				const heading = Math.sign( across ) || 1;
				const lean = - heading * THREE.MathUtils.clamp( Math.abs( across ) / ( pace * 3 ), 0, 1 ) * 0.15;
				const climb = heading * THREE.MathUtils.clamp( insect.velocity.y / pace, - 1, 1 ) * 0.1;

				insect.roll += ( bank + lean + climb - insect.roll ) * Math.min( 1, dt * 3 );
				tilt = insect.roll;

			}

			// the wings beat faster the harder it is working
			insect.frameTime += dt * insect.fps * insect.effort;
			const frameIndex = Math.floor( insect.frameTime % insect.frames.length );
			const frame = insect.frames[ frameIndex ];

			const uniforms = insect.mesh.material.uniforms;
			const tw = insect.textureWidth;
			const th = insect.textureHeight;

			uniforms.u_textureOffset.value.set( frame.frame.x / tw, frame.frame.y / th );
			uniforms.u_textureScale.value.set( frame.frame.w / tw, frame.frame.h / th );
			uniforms.u_geometryScale.value.set( frame.spriteSourceSize.w, frame.spriteSourceSize.h );
			uniforms.u_geometryOffset.value.set( frame.spriteSourceSize.x, - frame.spriteSourceSize.y );

			const strength = insect.strength;
			const t = insect.time / ( 0.5 + 0.5 * strength ) * 2;
			const mesh = insect.mesh;

			// The flinch when tapped: a sharp shudder and a pop in size, gone in a third of a
			// second.
			insect.flinch = Math.max( 0, insect.flinch - dt * 3 );
			const flinch = insect.flinch * insect.flinch;
			const shudder = Math.sin( insect.time * 55 ) * 0.5 * flinch;
			const pop = 1 + 0.3 * flinch;

			// The holder mirrors the drawing to face its way, which mirrors a roll too, so the
			// screen-space tilt is put back the right way round with `facing`.
			const roll = ( 0.12 * Math.cos( t + 2.734 ) + tilt + shudder ) * Math.sign( insect.facing || 1 );

			// Normalise the untrimmed frame to one unit tall, then centre it. The quad pivots at
			// its top-left corner, so the roll is taken about the drawing's middle by turning
			// the offset to that corner along with it — about the corner, banking into a turn
			// swung the whole insect sideways.
			const base = 1 / frame.sourceSize.h;
			const unit = base * pop;
			const cx = 0.5 * frame.sourceSize.w * unit;
			const cy = - 0.5 * frame.sourceSize.h * unit;
			const cos = Math.cos( roll );
			const sin = Math.sin( roll );

			mesh.position.set( - ( cx * cos - cy * sin ), - ( cx * sin + cy * cos ), 0 );
			mesh.scale.set( unit, unit, 1 );
			mesh.rotation.z = roll;

			// the original's "fly" action, verbatim
			mesh.position.x += Math.cos( 0.85 * t + 42.4 ) / base * 0.0015 * strength;
			mesh.position.y += Math.sin( 2 * t + 22.51235 ) / base * 0.00075 * strength;
			mesh.position.y += Math.max( 0, Math.cos( 6 * t + Math.sin( 3 * t ) ) ) / base * 0.0006 * strength;
			mesh.position.z += Math.cos( 0.75 * t + 223.54 ) / base * 0.0015 * strength;
			mesh.rotation.x = 0.2 * Math.cos( t + 1.51232 );

		}

	}

}

const _toTarget = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _side = new THREE.Vector3();
const _ring = new THREE.Vector3();
const _screen = new THREE.Vector3();
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
