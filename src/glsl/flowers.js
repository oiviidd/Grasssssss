import { simplexNoiseDerivatives } from './noise.js';

/**
 * ── FLOWERS ────────────────────────────────────────────────────────────────────
 * Instanced camera-facing billboards over a 5-cell atlas (flowers.png), picked by the
 * per-instance `flowerId`.
 *
 * The billboarding trick is in one line: the instance position is transformed to view
 * space *first*, and the quad's local offset is added afterwards
 * (`mvPosition.xyz += pos`). The quad therefore never rotates out of screen-plane
 * alignment, and no lookAt maths is needed.
 *
 * `v_color` is the giveaway that these are lit by the ground, not by a light: the
 * petals (yRatio > 0.01) are plain white — the atlas already carries their colour —
 * while the stem base picks up the terrain grass colour so it merges into the meadow.
 */
export const flowerVert = /* glsl */`
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

attribute vec3 instancePosition;
attribute float instanceSize;
attribute float flowerId;

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

// The original hard-coded 5 atlas cells. Made a uniform so an artist can supply a sheet
// with a different number of flowers without touching the shader.
uniform float u_atlasCells;

varying vec3 v_worldPosition;
varying vec3 v_viewNormal;
varying float v_yRatio;
varying vec3 v_color;
varying vec2 v_uv;

${simplexNoiseDerivatives}

void main () {
	float yRatio = uv.y;
	vec3 pos = position;

	pos = pos * instanceSize;
	pos += simplexNoiseDerivatives(vec4(instancePosition * 0.25, u_time * 0.3)).xyz * vec3(1.0, 0.3, 1.0) * 0.02 * yRatio * yRatio;

	vec2 terrainUv = ( instancePosition.xz - u_stageCentre ) / u_stageSize + 0.5;
	vec3 drawInfo = texture2D(u_terrainDrawTexture, terrainUv).rgb;
	drawInfo.xy = (drawInfo.xy * 2.0 - 1.0) * drawInfo.z ;

	v_color = yRatio > 0.01 ? vec3(1.0 + drawInfo.z * 0.3) : texture2D(u_terrainGrassTexture, terrainUv).rgb * 0.8;

	pos.xz  += drawInfo.xy * 0.02 * yRatio * yRatio;
	pos.y -= yRatio * yRatio * 0.01;

	vec4 mvPosition = modelViewMatrix * vec4(instancePosition, 1.0);
	mvPosition.xyz += pos;

	gl_Position = projectionMatrix * mvPosition;

	v_viewNormal = normalMatrix * normal;

	v_worldPosition = (modelMatrix * vec4(instancePosition, 1.0)).xyz;
	v_yRatio = position.y;
	v_uv = uv;
	v_uv.x = (v_uv.x + flowerId) / u_atlasCells;
}
`;

export const flowerFrag = /* glsl */`
uniform sampler2D u_texture;
uniform vec3 cameraPosition;

varying vec3 v_worldPosition;
varying vec3 v_viewNormal;
varying float v_yRatio;
varying vec3 v_color;
varying vec2 v_uv;

#include <lusionFog>

void main () {

	gl_FragColor = texture2D(u_texture, v_uv);
	gl_FragColor.rgb = applyFog(gl_FragColor.rgb * v_color, v_worldPosition);
	if (gl_FragColor.a < 0.004) discard;
}
`;
