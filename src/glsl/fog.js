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
 *                         sky. The fog *amount* is not depth based at all: it is a
 *                         2D rounded-box SDF around the origin on the xz plane, so
 *                         the diorama fades out at the edges of the "stage" no
 *                         matter where the camera is.
 *
 * Registered into THREE.ShaderChunk so both ShaderMaterial and RawShaderMaterial
 * can `#include <lusionFog>` (three resolves includes for raw materials too).
 */
export const fogChunk = /* glsl */`
uniform sampler2D u_envTexture;

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
	float d = sdRoundedBox(worldPosition.xz, vec2(2.5, 2.5), 1.0);
	float fog = clamp(d - 1.5, 0.0, 1.0);
	color = mix(color, fogColor, vec3(fog));
	return color;
}

vec3 sampleSky (vec3 dir) {
	return texture2D(u_envTexture, equirectUv(dir)).rgb;
}
`;
