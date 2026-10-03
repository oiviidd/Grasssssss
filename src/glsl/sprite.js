/**
 * ── INSECTS ────────────────────────────────────────────────────────────────────
 * The bee, dragonfly and fly on the original site are not 3D at all — they are
 * hand-drawn sprite sheets (5, 4 and 7 frames) on a flat double-sided quad, played
 * back at 30 fps. That is a large part of why the site reads as an illustration
 * rather than a render.
 *
 * The vertex shader does the atlas maths for a TexturePacker-style trimmed frame:
 *   • u_textureOffset / u_textureScale crop the frame out of the sheet
 *   • u_geometryScale / u_geometryOffset restore the trimmed transparent padding, so
 *     the wings stay put across frames instead of jittering
 * Note `uv.y` is flipped — the atlases are authored top-left origin.
 *
 * The fragment shader is deliberately unlit: no fog, no normal term. These sit on top
 * of the world as drawings, dimmed only by the time of day. `u_hasAlpha` switches
 * between an RGBA sprite and a single-channel mask read from .r (which the original
 * used for the black silhouettes).
 */
export const spriteVert = /* glsl */`
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 modelMatrix;
uniform mat3 normalMatrix;

uniform vec2 u_textureOffset;
uniform vec2 u_textureScale;
uniform vec2 u_geometryScale;
uniform vec2 u_geometryOffset;

varying vec3 v_worldPosition;
varying vec3 v_viewNormal;
varying vec2 v_uv;

void main () {
	vec3 pos = position;
	pos.xy *= u_geometryScale;
	pos.xy += u_geometryOffset;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

	v_viewNormal = normalMatrix * normal;
	v_worldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
	v_uv = vec2(uv.x, 1.0 - uv.y) * u_textureScale + u_textureOffset;
}
`;

export const spriteFrag = /* glsl */`
uniform sampler2D u_texture;
uniform vec3 cameraPosition;
uniform float u_hasAlpha;

varying vec3 v_worldPosition;
varying vec3 v_viewNormal;
varying vec2 v_uv;

#include <lusionFog>

void main () {
	gl_FragColor = texture2D(u_texture, v_uv);
	gl_FragColor = u_hasAlpha > 0.5 ? gl_FragColor : vec4(0.0, 0.0, 0.0, gl_FragColor.r);
	if (gl_FragColor.a < 0.1) discard;

	// Still no fog, but they share the time of day, the lamp included.
	gl_FragColor.rgb = applyLight(gl_FragColor.rgb, v_worldPosition);
}
`;
