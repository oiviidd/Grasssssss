/**
 * The whole "lighting rig" of the scene lives in this one chunk.
 *
 * There is not a single THREE.Light in the project. Instead:
 *   • `sampleSky(dir)`  — an equirectangular sky texture acts as the environment
 *                         light. Ambient/diffuse and specular are both just
 *                         directional lookups into it.
 *   • `applyFog(...)`   — aerial perspective. The fog *colour* is the sky in the
 *                         direction the fragment is being viewed from, so distant
 *                         geometry literally dissolves into the correct part of the
 *                         sky. The fog *amount* is the stronger of two terms:
 *
 *                           stage — a 2D rounded-box SDF on the xz plane, centred on
 *                                   the terrain. Dissolves the edges of the diorama
 *                                   wherever the camera happens to be.
 *                           haze  — distance from the eye, capped below 1. This is
 *                                   the depth cue: without it two landforms at
 *                                   different distances but similar positions take
 *                                   identical fog and read as a single silhouette.
 *
 * Registered into THREE.ShaderChunk so both ShaderMaterial and RawShaderMaterial
 * can `#include <lusionFog>` (three resolves includes for raw materials too).
 *
 * The time-of-day cycle (DayNight.js) also lands here, since this is the one place every
 * lit surface passes through: `applyLight` dims and cools the surface and adds the door
 * lamp, `skyView` tints what the fog dissolves into. Every one of those uniforms is
 * neutral at rest, so with the cycle off the frame is exactly the tuned daylight shot.
 */
export const fogChunk = /* glsl */`
uniform sampler2D u_envTexture;

// The original hard-coded the stage as a 2.5 x 2.5 rounded box of radius 1, fading over
// [1.5, 2.5]. Exposed as uniforms because those numbers decide how hard the ground's
// silhouette reads: with a low camera the horizon is formed by the furthest visible
// ground, which sits out where the fog has already dissolved it, so the edge smears over
// a wide band instead of ending cleanly.
uniform vec2 u_fogBox;
uniform float u_fogRadius;
uniform float u_fogStart;
uniform float u_fogRange;

// Where the stage box sits. Deliberately *not* tied to the terrain's centre: with the
// camera looking down -z, an origin-offset box is what dissolves the far horizon, because
// the ground reaches further back than the box does. Re-centring it on the terrain drops
// the stage term to zero everywhere and the horizon ends on a hard cut instead of melting
// into sky. Left as a tunable so a sculpt placed somewhere unusual can be re-fitted.
uniform vec2 u_fogCentre;

// Aerial perspective. u_hazeAmount caps it below 1 so distance tints and flattens the
// far ground without erasing it — full dissolve stays the stage term's job.
uniform float u_hazeStart;
uniform float u_hazeRange;
uniform float u_hazeAmount;

// Time of day. The sky texture is a fixed noon, so dusk and night are a tint on every sky
// lookup plus a glow around the sun and the moon; the surfaces, whose colour is mostly
// baked, take u_ambient instead of a relit sky. u_desaturate is the moonlight: at night the
// eye loses colour before it loses shape, so the meadow turns blue-grey rather than black.
uniform vec3 u_skyTint;
uniform vec3 u_ambient;
uniform float u_desaturate;
uniform vec3 u_sunDir;
uniform vec3 u_sunGlow;
uniform vec3 u_moonDir;
uniform vec3 u_moonGlow;

// The lantern over the cabin door, as a point light. u_lampNormal points out of the wall it
// hangs on and u_lampWall is how far in front of that wall it hangs, so nothing behind the
// wall is lit through it. u_lampRange is the distance at which the light has fallen to half.
uniform vec3 u_lampPosition;
uniform vec3 u_lampNormal;
uniform float u_lampWall;
uniform vec3 u_lampColor;
uniform float u_lampRange;

#define RECIPROCAL_PI 0.3183098861837907
#define RECIPROCAL_PI2 0.15915494309189535

vec2 equirectUv( in vec3 dir ) {
	// dir is assumed to be unit length
	float u = atan( dir.z, dir.x ) * RECIPROCAL_PI2 + 0.5;
	float v = -asin( clamp( dir.y, - 1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5;
	v = mix(v, v * v, 0.25);

    u *= 2.0;
    v = (v - 0.5) * 2.0 + 0.54;
	return vec2( u, v );
}

float sdRoundedBox( in vec2 p, in vec2 b, in float r ){
    vec2 q = abs(p)-b+r;
    return min(max(q.x,q.y),0.0) + length(max(q,0.0)) - r;
}

vec3 skyGlow(vec3 dir) {
	// Low sun: a hot lobe around it and a warm band along the whole horizon, both thinning
	// with height, so the glow sits behind the mountain instead of washing the zenith.
	float band = exp(-max(dir.y, 0.0) * 5.0);
	float sun = max(dot(dir, u_sunDir), 0.0);
	vec3 glow = u_sunGlow * band * (0.3 + pow(sun, 5.0) * 0.9 + pow(sun, 48.0) * 1.4);

	float moon = max(dot(dir, u_moonDir), 0.0);
	glow += u_moonGlow * (pow(moon, 24.0) * 0.25 + pow(moon, 600.0) * 0.6);

	return glow;
}

// The sky as seen along dir: what fog and haze dissolve into.
vec3 skyView(vec3 dir) {
	return texture2D(u_envTexture, equirectUv(dir)).rgb * u_skyTint + skyGlow(dir);
}

vec3 lampLight(vec3 worldPosition) {
	vec3 toPoint = worldPosition - u_lampPosition;
	float d = length(toPoint);
	float falloff = 1.0 / (1.0 + d * d / max(1e-4, u_lampRange * u_lampRange));
	falloff *= 1.0 - smoothstep(u_lampRange * 2.5, u_lampRange * 5.0, d);

	// Lit only in front of the wall the lantern hangs on, the wall itself included.
	float side = dot(toPoint, u_lampNormal);
	falloff *= smoothstep(- u_lampWall * 2.0, - u_lampWall, side);

	return u_lampColor * falloff;
}

// Surface colour under the time of day: ambient and moonlight, plus the lamp at full colour.
vec3 applyLight(vec3 color, vec3 worldPosition) {
	float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
	return mix(color, vec3(luma), u_desaturate) * u_ambient + color * lampLight(worldPosition);
}

vec3 applyFog(vec3 color, vec3 worldPosition) {
	color = applyLight(color, worldPosition);

	vec3 toCamera = worldPosition - cameraPosition;
	vec3 nToCamera = normalize(toCamera);

	vec3 fogColor = skyView(nToCamera);

	float d = sdRoundedBox(worldPosition.xz - u_fogCentre, u_fogBox, u_fogRadius);
	float stage = clamp((d - u_fogStart) / max(0.001, u_fogRange), 0.0, 1.0);

	float t = clamp((length(toCamera) - u_hazeStart) / max(0.001, u_hazeRange), 0.0, 1.0);
	float haze = t * t * (3.0 - 2.0 * t) * u_hazeAmount;

	color = mix(color, fogColor, vec3(max(stage, haze)));
	return color;
}

vec3 sampleSky (vec3 dir) {
	return texture2D(u_envTexture, equirectUv(dir)).rgb;
}
`;

/** Every uniform the chunk's time-of-day half reads, wired from the shared set. */
export const DAY_NIGHT_UNIFORMS = [
	'u_skyTint', 'u_ambient', 'u_desaturate', 'u_sunDir', 'u_sunGlow', 'u_moonDir', 'u_moonGlow',
	'u_lampPosition', 'u_lampNormal', 'u_lampWall', 'u_lampColor', 'u_lampRange'
];

export function dayNightUniforms( shared ) {

	const out = {};
	DAY_NIGHT_UNIFORMS.forEach( name => out[ name ] = shared[ name ] );
	return out;

}
