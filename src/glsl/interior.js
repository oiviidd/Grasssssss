/**
 * Shaders for the way into the cabin: the light round its door, the door itself, the hole it
 * leaves, the watercolour wash that carries the camera through, and the room inside.
 */

/** Hash and value noise shared by the full-screen passes. */
const noise = /* glsl */`
float hash12( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 hash22( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.xx + p3.yz ) * p3.zy );
}

float vnoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( hash12( i ), hash12( i + vec2( 1.0, 0.0 ) ), u.x ),
		mix( hash12( i + vec2( 0.0, 1.0 ) ), hash12( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}

float fbm( vec2 p ) {
	float sum = 0.0;
	float amplitude = 0.5;
	for ( int i = 0; i < 5; i ++ ) {
		sum += amplitude * vnoise( p );
		p = p * 2.03 + vec2( 17.1, 9.4 );
		amplitude *= 0.5;
	}
	return sum / 0.96875;
}
`;

/**
 * ── DOOR LIGHT ─────────────────────────────────────────────────────────────────
 * Warm light leaking round a closed door: a hairline along the gap, a little more under it,
 * and a soft halo on the wall. Added on top of the scene before the bloom, which is what turns
 * the hairline into a glow. Drawn on a plane a little larger than the door, in the door's own
 * units (model space), so it keeps its width whatever the cabin's scale.
 */
export const doorLightVert = /* glsl */`
varying vec2 v_local;

void main() {
	v_local = position.xy;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

export const doorLightFrag = /* glsl */`
uniform vec2 u_size;      // the door, model units
uniform vec3 u_color;
uniform float u_intensity;
uniform float u_time;
varying vec2 v_local;

void main() {
	// signed distance to the door's outline, positive outside
	vec2 q = abs( v_local ) - u_size * 0.5;
	float d = length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 );

	float under = smoothstep( 0.0, - u_size.y * 0.5, v_local.y ); // 1 at the sill
	float seam = exp( - abs( d ) / ( 0.0035 + 0.003 * under ) ) * ( 0.55 + 0.9 * under );
	float halo = exp( - max( d, 0.0 ) / 0.05 ) * step( 0.0, d ) * 0.22;

	// breathing, never in step with itself
	float breath = 0.82 + 0.12 * sin( u_time * 1.7 ) + 0.06 * sin( u_time * 4.1 + 1.3 );

	gl_FragColor = vec4( u_color * ( seam + halo ) * u_intensity * breath, 1.0 );
}
`;

/**
 * ── THE DOOR LEAF ──────────────────────────────────────────────────────────────
 * The door on the model is painted into the cabin's own mesh, so it cannot swing. At the
 * click the frame is captured and the leaf takes its face from that capture, projected
 * through the camera that took it — a projective texture, so it stays put on the leaf as
 * the leaf turns. Edges and back read as the same wood in shade.
 */
export const leafVert = /* glsl */`
uniform mat4 u_captureMatrix; // capture camera's view-projection × the closed leaf's world matrix
varying vec4 v_capture;
varying vec3 v_normal;
varying vec3 v_worldNormal;
varying vec3 v_worldPosition;

void main() {
	v_capture = u_captureMatrix * vec4( position, 1.0 );
	v_normal = normal;
	vec4 world = modelMatrix * vec4( position, 1.0 );
	v_worldPosition = world.xyz;
	v_worldNormal = normalize( mat3( modelMatrix ) * normal );
	gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const leafFrag = /* glsl */`
uniform sampler2D u_capture;
uniform vec3 u_light;       // the warm light from inside, already scaled by how open the door is
uniform vec3 u_lightPosition;
varying vec4 v_capture;
varying vec3 v_normal;
varying vec3 v_worldNormal;
varying vec3 v_worldPosition;

void main() {
	vec2 uv = v_capture.xy / v_capture.w * 0.5 + 0.5;
	vec3 face = texture2D( u_capture, clamp( uv, vec2( 0.001 ), vec2( 0.999 ) ) ).rgb;

	// the outside face as captured; the edges and the inside face are the same wood, unlit
	float front = step( 0.5, v_normal.z );
	vec3 color = face * mix( 0.55, 1.0, front );

	// the room's light catches whatever of the leaf faces it
	vec3 toLight = u_lightPosition - v_worldPosition;
	float facing = max( dot( v_worldNormal, normalize( toLight ) ), 0.0 );
	color += u_light * facing * ( 1.0 - front * 0.6 ) / ( 1.0 + dot( toLight, toLight ) * 6.0 );

	gl_FragColor = vec4( color, 1.0 );
}
`;

/**
 * ── THE DOORWAY ────────────────────────────────────────────────────────────────
 * Where the door was. Writes alpha 0 — every other surface in the scene writes 1 — so the
 * composite below knows, through the bloom and the grade, which pixels look into the room.
 */
export const holeFrag = /* glsl */`
void main() {
	gl_FragColor = vec4( 0.0 );
}
`;

/**
 * ── THE PASSAGE ────────────────────────────────────────────────────────────────
 * Composites the graded meadow and the room. Two things happen here:
 *
 *   the doorway  — pixels the scene marked as the hole show the room, shaded as if seen
 *                  through a frame: darker in the reveal, lit toward the floor. Its light
 *                  spills onto the wall and the grass round it.
 *   the wash     — a watercolour bloom: a wet edge, warped by noise, spreading out from the
 *                  door. The room comes in behind it; the edge pools darker pigment, lifts the
 *                  paper just ahead of itself, and pushes the meadow along like a wave of water.
 *
 * u_progress is how much of the screen the room has taken: 0 → 1 going in, 1 → 0 coming out.
 */
export const passageFrag = /* glsl */`
uniform sampler2D u_outside;
uniform sampler2D u_inside;
uniform sampler2D u_scene;    // its alpha: 0 where the doorway is
uniform mat3 u_doorFromClip;  // clip-space x, y, w → door uv (0..1 across the doorway)
uniform vec2 u_doorAspect;    // the doorway's width and height, for distances in its plane
uniform float u_doorOpen;     // 0..1, how much light comes through
uniform float u_hole;         // 1 while the doorway is in the scene
uniform vec3 u_lightColor;
uniform float u_progress;
uniform vec2 u_origin;        // screen uv the wash grows from
uniform float u_aspect;
uniform float u_time;
uniform float u_seed;
uniform vec2 u_resolution;

varying vec2 v_uv;

${ noise }

const vec3 PAPER = vec3( 0.96, 0.93, 0.86 );
const vec3 PIGMENT = vec3( 0.70, 0.56, 0.48 );

void main() {

	/* the meadow, and the room through the doorway ------------------------------ */

	vec3 door = u_doorFromClip * vec3( v_uv * 2.0 - 1.0, 1.0 );
	vec2 du = door.xy / door.z;
	bool ahead = door.z > 0.0;

	// how far outside the doorway, in its own plane, scaled to its height
	vec2 outside = max( max( - du, du - 1.0 ), 0.0 ) * u_doorAspect / u_doorAspect.y;
	float away = length( outside );

	/* the wash ------------------------------------------------------------------ */

	vec2 p = ( v_uv - u_origin ) * vec2( u_aspect, 1.0 );
	vec2 warp = vec2( fbm( v_uv * 2.6 + u_seed ), fbm( v_uv * 2.6 + u_seed + 5.2 ) ) - 0.5;
	float grow = u_progress;
	p += warp * ( 0.25 + 0.45 * grow );

	float reach = length( vec2( u_aspect, 1.0 ) ) * 1.15 + 0.35;
	float radius = mix( - 0.2, reach, grow );
	float fray = fbm( v_uv * vec2( 6.0 * u_aspect, 6.0 ) + u_seed * 3.1 + u_time * 0.04 ) - 0.5;
	float edge = length( p ) - radius + fray * ( 0.10 + 0.22 * grow );

	float room = 1.0 - smoothstep( - 0.006, 0.006, edge );
	float rim = room * ( 1.0 - smoothstep( 0.0, 0.07, - edge ) );        // just inside the edge
	float wet = ( 1.0 - room ) * ( 1.0 - smoothstep( 0.0, 0.14, edge ) ); // just ahead of it

	// the water front shoves the meadow outward as it comes
	vec2 push = normalize( p + 1e-5 ) / vec2( u_aspect, 1.0 );
	vec2 outsideUv = v_uv - push * wet * wet * 0.035;

	vec4 sceneTexel = texture2D( u_scene, outsideUv );
	vec3 meadow = texture2D( u_outside, outsideUv ).rgb;
	vec3 inside = texture2D( u_inside, v_uv ).rgb;

	if ( u_hole > 0.5 && ahead ) {

		float hole = 1.0 - sceneTexel.a;

		float frame = min( min( du.x, 1.0 - du.x ) * u_doorAspect.x, min( du.y, 1.0 - du.y ) * u_doorAspect.y ) / u_doorAspect.y;
		float shade = mix( 0.45, 1.0, smoothstep( 0.0, 0.16, frame ) );
		shade *= mix( 0.75, 1.0, smoothstep( 1.0, 0.55, du.y ) );
		// The room through the doorway, framed by it: its full height fills the opening and as
		// much of its width as the opening's shape allows, round the rack. Sampled in screen
		// space instead, a doorway a fifth of the frame showed a fifth of the room, blown up.
		// It slides a little with where the door is on screen, as a room behind it would.
		vec2 room = vec2(
			0.5 + ( du.x - 0.5 ) * u_doorAspect.x / u_doorAspect.y / u_aspect * 0.92 - ( u_origin.x - 0.5 ) * 0.12,
			0.04 + du.y * 0.92 );
		vec3 view = texture2D( u_inside, clamp( room, vec2( 0.001 ), vec2( 0.999 ) ) ).rgb;
		vec3 through = view * shade * mix( 0.5, 1.3, u_doorOpen ) + u_lightColor * 0.18 * u_doorOpen * smoothstep( 0.7, 0.0, du.y );

		// light spilled on the wall and the grass round the frame, strongest below the sill
		float sill = smoothstep( 0.04, - 0.06, du.y ) * smoothstep( - 0.35, 0.15, du.x ) * smoothstep( 1.35, 0.85, du.x );
		float spill = exp( - away * 7.0 ) * ( 1.0 + 1.2 * sill * exp( - away * 2.0 ) );
		meadow += u_lightColor * spill * u_doorOpen * 0.22 * ( 1.0 - hole );

		meadow = mix( meadow, through, hole );

	}

	/* paint ---------------------------------------------------------------------- */

	// paper lifted ahead of the wet edge
	meadow = mix( meadow, PAPER, wet * 0.28 );

	// pigment pooled in the edge, and the grain of the paper it settled into
	float grain = vnoise( v_uv * u_resolution / 2.5 ) * 0.6 + vnoise( v_uv * u_resolution / 9.0 ) * 0.4;
	vec3 room3 = inside * mix( vec3( 1.0 ), PIGMENT, rim * ( 0.45 + 0.25 * grain ) );

	// blooms of lighter wash inside the colour while it is still wet
	float back = smoothstep( 0.58, 0.8, fbm( v_uv * 4.0 + u_seed * 1.7 ) ) * ( 1.0 - smoothstep( 0.55, 1.0, grow ) );
	room3 = mix( room3, mix( room3, PAPER, 0.45 ), back * 0.35 );

	vec3 color = mix( meadow, room3, room );

	gl_FragColor = vec4( color + ( hash12( gl_FragCoord.xy + u_seed ) - 0.5 ) / 255.0, 1.0 );

}
`;

/**
 * ── THE ROOM ───────────────────────────────────────────────────────────────────
 * One painting, three times of day (day, sunset, night), blended by the clock. It is a flat
 * picture, so the life is put back by hand:
 *
 *   depth     — a hand-drawn depth map (Interior.js) parallaxes the rack against the wall
 *               and the view out of the windows against both, with the pointer and a slow
 *               drift of its own;
 *   cloth     — the coats sway a little from their hangers, more in the draught after the
 *               door has opened;
 *   outside   — the sky in the windows drifts and the grass under it moves in the wind;
 *               after dark, stars twinkle and a few fireflies wander past;
 *   light     — by day the sunlight dims and returns as clouds pass, dust turns in it;
 *               by night the lamplight flickers.
 *
 * u_wash renders it as wet watercolour — blurred, bled, its edges darkened, its grain
 * lifted — and dries it back to the painting as it falls to 0.
 */
export const interiorFrag = /* glsl */`
uniform sampler2D u_day;
uniform sampler2D u_sunset;
uniform sampler2D u_night;
uniform sampler2D u_mask;     // r depth (1 near), g cloth, b window view
uniform vec3 u_weights;       // day, sunset, night
uniform vec2 u_resolution;
uniform float u_imageAspect;
uniform float u_time;
uniform vec2 u_parallax;      // -1..1
uniform vec2 u_focus;         // image uv the crop centres on
uniform float u_zoom;
uniform float u_wash;
uniform float u_gust;

varying vec2 v_uv;

${ noise }

vec3 paint( vec2 uv, float bias ) {
	vec3 color = vec3( 0.0 );
	if ( u_weights.x > 0.001 ) color += texture2D( u_day, uv, bias ).rgb * u_weights.x;
	if ( u_weights.y > 0.001 ) color += texture2D( u_sunset, uv, bias ).rgb * u_weights.y;
	if ( u_weights.z > 0.001 ) color += texture2D( u_night, uv, bias ).rgb * u_weights.z;
	return color;
}

float motes( vec2 p, float t ) {
	float sum = 0.0;
	for ( int i = 0; i < 3; i ++ ) {
		float fi = float( i );
		float scale = 9.0 + fi * 6.0;
		vec2 q = p * scale + vec2( t * ( 0.05 + 0.03 * fi ), t * ( 0.035 + 0.02 * fi ) ) + fi * 13.7;
		vec2 cell = floor( q );
		vec2 h = hash22( cell + fi * 7.0 );
		vec2 centre = 0.25 + 0.5 * h + 0.18 * vec2( sin( t * 0.5 + h.x * 6.28 ), cos( t * 0.43 + h.y * 6.28 ) );
		float d = length( fract( q ) - centre );
		float size = 0.04 + 0.05 * h.y;
		float twinkle = 0.55 + 0.45 * sin( t * ( 0.8 + h.x * 1.6 ) + h.y * 20.0 );
		sum += step( 0.62, hash12( cell + 3.1 + fi ) ) * twinkle * smoothstep( size, 0.0, d ) * ( 1.0 - fi * 0.3 );
	}
	return sum;
}

void main() {

	float t = u_time;
	float screenAspect = u_resolution.x / u_resolution.y;

	// cover the screen, cropped round the focus, zoomed past the edges by enough for the parallax
	vec2 span = screenAspect > u_imageAspect
		? vec2( 1.0, u_imageAspect / screenAspect )
		: vec2( screenAspect / u_imageAspect, 1.0 );
	span /= u_zoom;
	vec2 focus = clamp( u_focus, span * 0.5, 1.0 - span * 0.5 );
	vec2 uv = focus + ( v_uv - 0.5 ) * span;

	vec3 mask = texture2D( u_mask, uv ).rgb;
	float down = 1.0 - uv.y; // image rows, 0 at the top

	// depth: near things slide with the eye, the view out of the windows against it
	uv -= u_parallax * ( mask.r - 0.42 ) * 0.014 * span;

	// cloth swaying from the hangers, more for a while once the door has let the air in
	float hang = pow( smoothstep( 0.47, 1.0, down ), 1.3 );
	float sway = sin( t * 0.9 + uv.x * 11.0 ) * 0.6 + sin( t * 1.37 + uv.x * 23.0 + 1.3 ) * 0.4;
	sway += ( vnoise( vec2( uv.x * 6.0, t * 0.5 ) ) - 0.5 ) * 1.2 * u_gust;
	uv.x += sway * ( 0.0009 + 0.0035 * u_gust ) * hang * mask.g;

	// the view outside: the sky drifts, the grass moves in the wind
	float meadow = smoothstep( 0.40, 0.50, down );
	vec2 flow = vec2( vnoise( uv * vec2( 14.0, 9.0 ) + vec2( t * 0.08, 0.0 ) ), vnoise( uv * vec2( 14.0, 9.0 ) + 17.0 - t * 0.05 ) ) - 0.5;
	uv += flow * 0.0022 * mask.b * ( 1.0 - meadow );
	uv.x += sin( t * 1.9 + uv.y * 150.0 + vnoise( uv * 40.0 + t * 0.5 ) * 4.0 ) * 0.0007 * meadow * mask.b * smoothstep( 0.4, 0.58, down );

	// wet: bled sideways by the water, blurred
	uv += ( vec2( fbm( uv * 5.0 + t * 0.12 ), fbm( uv * 5.0 + 7.3 - t * 0.1 ) ) - 0.5 ) * 0.03 * u_wash;
	uv = clamp( uv, vec2( 0.001 ), vec2( 0.999 ) );

	vec3 color = paint( uv, u_wash * 3.5 );

	if ( u_wash > 0.001 ) {

		// watercolour: pigment darkens where tones change, pools in grain, the paper shows
		vec3 soft = paint( uv, u_wash * 3.5 + 2.0 );
		float lum = dot( color, vec3( 0.299, 0.587, 0.114 ) );
		float softLum = dot( soft, vec3( 0.299, 0.587, 0.114 ) );
		color *= 1.0 - clamp( abs( lum - softLum ) * 3.0, 0.0, 0.45 ) * u_wash;
		float grain = vnoise( v_uv * u_resolution / 3.0 ) * 0.5 + vnoise( v_uv * u_resolution / 11.0 ) * 0.5;
		color *= 1.0 - ( grain - 0.5 ) * 0.22 * u_wash;
		color = mix( color, vec3( 0.96, 0.93, 0.86 ), u_wash * 0.2 * ( 1.0 - lum ) );

	}

	float lum = dot( color, vec3( 0.299, 0.587, 0.114 ) );
	float warm = clamp( ( color.r - color.b ) * 2.2, 0.0, 1.0 );
	float daylight = u_weights.x + u_weights.y * 0.8;

	// clouds over the sun: the lit patches dim and come back
	float cloud = vnoise( vec2( uv.x * 1.6 - t * 0.05, t * 0.03 ) );
	color *= 1.0 + ( cloud - 0.5 ) * 0.16 * daylight * smoothstep( 0.35, 0.85, lum ) * ( 1.0 - mask.b );

	// lamplight that breathes
	float flame = sin( t * 7.3 ) * 0.5 + sin( t * 13.1 + 1.7 ) * 0.3 + ( vnoise( vec2( t * 3.0, 0.0 ) ) - 0.5 ) * 0.8;
	color *= 1.0 + flame * 0.045 * u_weights.z * warm;

	// dust in the light
	vec2 screen = v_uv * vec2( screenAspect, 1.0 ) + u_parallax * 0.012;
	float dust = motes( screen, t ) * ( smoothstep( 0.3, 0.85, lum ) * 0.85 + 0.15 );
	color += vec3( 1.0, 0.86, 0.66 ) * dust * ( 0.16 * daylight + 0.07 * u_weights.z * warm );

	// after dark: stars in the window sky, fireflies over its grass
	if ( u_weights.z > 0.001 ) {

		vec2 sq = uv * vec2( 150.0, 85.0 );
		vec2 cell = floor( sq );
		float star = step( 0.93, hash12( cell ) ) * smoothstep( 0.18, 0.0, length( fract( sq ) - 0.5 ) );
		star *= 0.5 + 0.5 * sin( t * ( 1.5 + hash12( cell + 1.0 ) * 3.0 ) + hash12( cell + 2.0 ) * 6.28 );
		color += vec3( 0.85, 0.9, 1.0 ) * star * mask.b * ( 1.0 - meadow ) * smoothstep( 0.3, 0.1, lum ) * u_weights.z * 0.8;

		vec2 fq = uv * vec2( 40.0, 22.0 ) + vec2( t * 0.06, sin( t * 0.3 ) * 0.2 );
		vec2 fcell = floor( fq );
		vec2 fh = hash22( fcell );
		vec2 fc = 0.3 + 0.4 * fh + 0.2 * vec2( sin( t * 0.7 + fh.x * 6.28 ), cos( t * 0.9 + fh.y * 6.28 ) );
		float fly = step( 0.8, hash12( fcell + 5.0 ) ) * exp( - length( fract( fq ) - fc ) * 18.0 );
		fly *= smoothstep( 0.2, 1.0, sin( t * ( 0.9 + fh.x ) + fh.y * 9.0 ) );
		color += vec3( 0.85, 1.0, 0.45 ) * fly * mask.b * meadow * u_weights.z * 0.9;

	}

	// a soft vignette, and dither
	vec2 centred = ( v_uv - 0.5 ) * vec2( screenAspect, 1.0 );
	color *= 1.0 - smoothstep( 0.45, 1.25, length( centred ) / max( screenAspect, 1.0 ) * 1.4 ) * 0.28;

	gl_FragColor = vec4( color + ( hash12( gl_FragCoord.xy + fract( t ) * 91.0 ) - 0.5 ) / 255.0, 1.0 );

}
`;
