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

vec3 applyFog(vec3 color, vec3 worldPosition) {
	vec3 toCamera = worldPosition - cameraPosition;
	vec3 nToCamera = normalize(toCamera);

	vec3 fogColor = texture2D(u_envTexture, equirectUv(nToCamera)).rgb;

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
