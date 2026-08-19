import { simplexNoiseDerivatives, qRotate } from './noise.js';

/**
 * ── INSTANCED GRASS ────────────────────────────────────────────────────────────
 * One 7-vertex blade (grass.buf) drawn 48 768 times. Each instance carries a
 * baked world position, an orientation quaternion and a scale, all authored in
 * Houdini/C4D and exported as a point cloud (grass_placement.buf).
 *
 * `position.y` doubles as the along-the-blade ratio (0 at the root, 1 at the tip),
 * so every displacement below is weighted by `yRatio * yRatio` — the root stays
 * pinned to the ground and the bend accelerates towards the tip.
 */
export const instancedGrassVert = /* glsl */`
attribute vec3 position;
attribute vec3 normal;

attribute vec3 instancePosition;
attribute vec4 instanceQrient;
attribute float instanceSize;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 modelMatrix;
uniform mat3 normalMatrix;
uniform float u_time;

uniform sampler2D u_terrainGrassTexture;
uniform sampler2D u_terrainDrawTexture;

// The stage box the baked terrain maps cover: world xz centre and its square span.
// It follows the loaded mesh rather than being pinned to 10 units at the origin, so an
// off-centre sculpt still reads its own colour instead of clamped edge pixels.
uniform vec2 u_stageCentre;
uniform float u_stageSize;

varying vec3 v_worldPosition;
varying vec3 v_viewNormal;
varying vec3 v_color;
varying float v_yRatio;
varying vec3 v_offset;

${simplexNoiseDerivatives}
${qRotate}

void main () {
	vec2 terrainUv = ( instancePosition.xz - u_stageCentre ) / u_stageSize + 0.5;
	vec3 drawInfo = texture2D(u_terrainDrawTexture, terrainUv).rgb;
	drawInfo.xy = (drawInfo.xy * 2.0 - 1.0) * drawInfo.z;

	float yRatio = position.y;
	vec3 pos = position;

	pos = qRotate(instanceQrient, pos) * instanceSize;

	v_offset = simplexNoiseDerivatives(vec4(instancePosition * 0.25, u_time * 0.3 + cos(u_time) * 0.1)).xyz * vec3(1.0, 0.3, 1.0);

	pos += v_offset * 0.02 * yRatio * yRatio;
	pos.xz  += drawInfo.xy * 0.06 * yRatio * yRatio;
	pos.y -= yRatio * yRatio * 0.03;

	pos += instancePosition;

	vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
	gl_Position = projectionMatrix * mvPosition;

	v_color = texture2D(u_terrainGrassTexture, terrainUv).rgb * (0.8 + yRatio * 0.2 + drawInfo.z * yRatio * 0.5);

	v_viewNormal = normalMatrix * qRotate(instanceQrient, normal);

	v_worldPosition = (modelMatrix * vec4(pos, 1.0)).xyz;
	v_yRatio = position.y;
}
`;

/**
 * The blade is *not* lit per-pixel in any classical sense. Its albedo already came
 * from the terrain colour map in the vertex stage; the fragment stage only adds:
 *   1. a ±5% wrap term along the fixed sun direction vec3(0.5733),
 *   2. a yellow-green "wind flash" (0.737, 1.0, 0.0235) that is strongest where the
 *      noise field is pushing upward AND the blade faces the sun — this is what
 *      makes gusts read as travelling waves of light across the meadow,
 *   3. aerial perspective.
 */
export const instancedGrassFrag = /* glsl */`
uniform vec3 cameraPosition;

varying vec3 v_worldPosition;
varying vec3 v_viewNormal;
varying vec3 v_color;
varying float v_yRatio;
varying vec3 v_offset;

#include <lusionFog>

void main () {
	vec3 viewNormal = normalize(v_viewNormal);
	float diff = dot(vec3(0.5733),  viewNormal);
	gl_FragColor = vec4(v_color * (1.0 + dot(vec3(0.5733),  viewNormal) * 0.05), 1.0);

	gl_FragColor.rgb += max(0.0, v_offset.y + 0.25) * v_yRatio * smoothstep(-0.25, 1.0, diff) * 0.175 * vec3(0.7372549019607844,1.,0.023529411764705882);

	gl_FragColor.rgb = applyFog(clamp(gl_FragColor.rgb, vec3(0.0), vec3(1.0)), v_worldPosition);
}
`;

/**
 * ── SCULPTED GRASS CLUMPS ──────────────────────────────────────────────────────
 * hero_grass / float_plants / water_plants are single hand-modelled meshes, not
 * instanced. They ship a `yRatio` attribute (and, for the water plants, a baked
 * `occlusion` attribute) instead of deriving it from position.y, and they read the
 * wind field from their own world position so neighbouring clumps stay in phase
 * with the surrounding instanced grass.
 */
export const plantVert = /* glsl */`
attribute float yRatio;
attribute vec3 position;
attribute vec3 normal;

#ifdef USE_AO
	attribute float occlusion;
#endif

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 modelMatrix;
uniform mat3 normalMatrix;
uniform float u_time;
uniform float u_movementStrength;

uniform sampler2D u_terrainGrassTexture;
uniform sampler2D u_terrainDrawTexture;

// The stage box the baked terrain maps cover: world xz centre and its square span.
// It follows the loaded mesh rather than being pinned to 10 units at the origin, so an
// off-centre sculpt still reads its own colour instead of clamped edge pixels.
uniform vec2 u_stageCentre;
uniform float u_stageSize;

varying vec3 v_worldPosition;
varying vec3 v_viewNormal;
varying vec3 v_color;
varying float v_yRatio;

${simplexNoiseDerivatives}
${qRotate}

void main () {
	vec2 terrainUv = ( position.xz - u_stageCentre ) / u_stageSize + 0.5;
	vec3 drawInfo = texture2D(u_terrainDrawTexture, terrainUv).rgb;
	drawInfo.xy = (drawInfo.xy * 2.0 - 1.0) * drawInfo.z;

	vec3 pos = position;
	pos += simplexNoiseDerivatives(vec4(position * 0.25, u_time * 0.3)).xyz * vec3(0.02, 0.0, 0.02) * yRatio * yRatio * u_movementStrength;

	pos.xz  += drawInfo.xy * 0.01 * yRatio * yRatio;
	pos.y -= yRatio * yRatio * 0.005;

	vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
	gl_Position = projectionMatrix * mvPosition;

	v_color = texture2D(u_terrainGrassTexture, terrainUv).rgb * (0.8 + yRatio * 0.2 + drawInfo.z * yRatio);

	#ifdef USE_AO
		v_color = v_color * (0.25 + occlusion * 1.75);
	#endif

	v_viewNormal = normalMatrix * normal;

	v_worldPosition = (modelMatrix * vec4(pos, 1.0)).xyz;
	v_yRatio = yRatio;
}
`;

export const plantFrag = /* glsl */`
uniform vec3 cameraPosition;

varying vec3 v_worldPosition;
varying vec3 v_viewNormal;
varying vec3 v_color;

#include <lusionFog>

void main () {
	gl_FragColor = vec4(v_color * (1.0 + dot(vec3(0.5733),  normalize(v_viewNormal)) * 0.05), 1.0);
	gl_FragColor.rgb = applyFog(clamp(gl_FragColor.rgb, vec3(0.0), vec3(1.0)), v_worldPosition);
}
`;
