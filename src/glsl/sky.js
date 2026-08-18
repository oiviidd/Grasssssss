import { simplexNoiseDerivatives } from './noise.js';

/**
 * ── SKY ────────────────────────────────────────────────────────────────────────
 * A radius-15 sphere pinned to the camera, rendered from the inside. The env map
 * is sampled twice — once along the view direction and once along a mirrored
 * direction — and cross-faded by a scrolling noise channel. That is the whole
 * cloud animation: no volumetrics, just two lookups drifting against each other.
 *
 * Note the vertex shader displaces `pos` for the *sampling* direction but keeps
 * `gl_Position` on the undisplaced sphere, so the sky wobbles without the geometry
 * ever moving.
 */
export const skyVert = /* glsl */`
uniform float u_time;
varying vec3 v_worldPosition;
varying vec3 v_originalWorldPosition;

${simplexNoiseDerivatives}

void main () {
	vec3 pos = position + simplexNoiseDerivatives(vec4(position * 5.0, u_time * 0.05)).xyz * 0.04;
	v_worldPosition = (modelMatrix * vec4(pos, 1.0)).xyz;
	v_originalWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const skyFrag = /* glsl */`
uniform sampler2D u_noiseTexture;
uniform float u_time;
varying vec3 v_worldPosition;
varying vec3 v_originalWorldPosition;

#include <lusionFog>

void main () {
    vec3 worldDir = normalize(v_worldPosition - cameraPosition);
    vec2 uv = equirectUv(worldDir);

    worldDir = normalize(v_originalWorldPosition * 2.0 - v_worldPosition - cameraPosition);
    vec2 uv2 = equirectUv(worldDir);

    vec3 displacement = texture2D(u_noiseTexture, uv * vec2(30.0 , 15.0)).xyz;
    vec3 displacement2 = texture2D(u_noiseTexture, uv2 * vec2(40. , 20.0)).xyz;

    displacement.x = abs(fract(u_time * 0.1 + displacement.x) - 0.5) * 3.5;

    gl_FragColor = mix(
        texture2D(u_envTexture, uv + (displacement.yz - 0.5) * vec2(0.005, 0.0025)),
        texture2D(u_envTexture, uv2 + (displacement2.yz - 0.5) * vec2(0.005, 0.0025)),
        displacement.xxxx
    );
}
`;
