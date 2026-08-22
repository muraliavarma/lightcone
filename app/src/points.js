// Points rendering (§6.2). One THREE.Points per chunk file, one shared
// ShaderMaterial per layer, one shared uniform block for the whole app so a
// single write drives every chunk. No per-frame allocation.
import * as THREE from '../vendor/three/three.module.js';
import { LAYERS, R_SKY, GAIN3_REF, GAIN3_MAX, GAIN3_POW } from './config.js';

// The §6.1 unfold, done entirely in the vertex shader: both the sky-sphere
// position and the true position are derivable from the xyz attribute alone.
const UNFOLD = /* glsl */`
  float d = length(position);
  vec3 dir = d > 1e-4 ? position / d : vec3(0.0, 0.0, 1.0);
  vec3 unfolded = mix(dir * uRSky, position, uMix);
`;

const VERT = /* glsl */`
uniform float uMix, uRSky, uAtten, uDpr, uSize, uMinPx, uMaxPx, uMaxPx3;
uniform float uOpacity, uOpacity3, uFadeRef, uNearRef, uGain3, uRing, uFocusR;
uniform float uLens, uLensLo, uLensHi;
uniform vec2 uCursor;
uniform vec3 uColor, uFocus;
varying vec4 vCol;
varying float vRing;
void main() {
${UNFOLD}
  vec4 mv = modelViewMatrix * vec4(unfolded, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 1.0);
  // over a live photograph the dots become open rings (§6.3) — a galaxy has to
  // be distinguishable from the thousand foreground stars in the same frame, and
  // a filled dot is not. But a thousand rings bury the photograph, so they only
  // come up in a soft spotlight around the cursor: the photo reads as a
  // photograph, and the affordance appears where you are actually pointing.
  vec2 ndc = gl_Position.xy / max(gl_Position.w, 1e-6);
  float ringF = uRing * smoothstep(0.60, 0.18, distance(ndc, uCursor));
  vRing = ringF;
  // The time lens is a radial shell in comoving space. It works in both views:
  // on the photograph it reveals which projected objects share an epoch; in 3D
  // it becomes a clean cross-section through the cosmic web.
  float lensEdge = max(8.0, (uLensHi - uLensLo) * 0.16);
  float lensBand = smoothstep(uLensLo - lensEdge, uLensLo + lensEdge, d) *
                   (1.0 - smoothstep(uLensHi - lensEdge, uLensHi + lensEdge, d));
  float lensFloor = mix(0.04, 0.015, uMix);
  float lensPeak = mix(2.2, 8.0, uMix);
  float lensGain = mix(lensFloor, lensPeak, lensBand);
  // Rings and in-epoch points need room, so they get a restrained size boost.
  float boost = (1.0 + 0.75 * ringF) * mix(1.0, 1.0 + 0.35 * lensBand, uLens);
  gl_PointSize = clamp(uSize * boost * uAtten / dist,
                       uMinPx, mix(uMaxPx, uMaxPx3, uMix) * boost) * uDpr;
  // Depth modulation, one cue per stage. On the sky sphere every point is the
  // same distance away, so the only honest cue is its own comoving distance:
  // the deep quasars read fainter than the nearby galaxies. Once unfolded, the
  // cue is distance from the camera, referenced to whatever the camera is
  // currently standing off from (uNearRef) — so the thing you flew to is
  // properly exposed while the millions behind it fall away instead of
  // stacking additively into a white fog.
  float fade2 = mix(1.0, 0.38, clamp(d / uFadeRef, 0.0, 1.0));
  float fade3 = 2.44 * uGain3 * pow(clamp(uNearRef / (uNearRef + dist), 0.0, 1.0), 1.6);
  // Once you have flown to a specific structure, the two hundred galaxies that
  // make up its finger of god sit inside a foreground of tens of thousands that
  // happen to lie along the same sight line. Exposure falls off with distance
  // from the thing you flew to, the way focus does — nothing is hidden, the
  // surroundings just stop out-shouting the subject. Off unless a focus is set.
  if (uFocusR > 0.0) {
    fade3 *= mix(1.0, 0.16, smoothstep(uFocusR, uFocusR * 3.0, length(unfolded - uFocus)));
  }
  float alpha = mix(uOpacity * fade2, uOpacity3 * fade3, uMix);
  vCol = vec4(uColor, alpha * mix(1.0, lensGain, uLens));
}`;

const FRAG = /* glsl */`
precision mediump float;
varying vec4 vCol;
varying highp float vRing;   // must match the vertex stage's default precision
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  float disc = smoothstep(0.25, 0.03, r2);
  float r = sqrt(r2) * 2.0;
  float ring = smoothstep(0.50, 0.72, r) * smoothstep(1.0, 0.82, r);
  gl_FragColor = vec4(vCol.rgb, vCol.a * mix(disc, ring, vRing));
}`;

const PICK_VERT = /* glsl */`
uniform float uMix, uRSky, uPickSize, uChunk, uLens, uLensLo, uLensHi;
flat out vec4 vId;
void main() {
${UNFOLD}
  float edge = max(8.0, (uLensHi - uLensLo) * 0.20);
  if (uLens > 0.5 && (d < uLensLo - edge || d > uLensHi + edge)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
  } else {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(unfolded, 1.0);
    gl_PointSize = uPickSize;
  }
  int i = gl_VertexID;
  vId = vec4(float(i & 255), float((i >> 8) & 255), float((i >> 16) & 255), uChunk) / 255.0;
}`;

const PICK_FRAG = /* glsl */`
precision highp float;
flat in vec4 vId;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  outColor = vId;
}`;

export class PointField {
  constructor() {
    this.scene = new THREE.Scene();
    this.pickScene = new THREE.Scene();
    this.chunks = [];                    // {layer, count, mesh, pick, pos, sec, tid}
    this.pointsLoaded = 0;

    // Shared across every material — write once per frame.
    this.shared = {
      uMix:     { value: 0 },
      uRSky:    { value: R_SKY },
      uAtten:   { value: 800 },
      uDpr:     { value: 1 },
      uFadeRef: { value: R_SKY },
      uNearRef: { value: GAIN3_REF },
      uGain3:   { value: 1 },
      uRing:    { value: 0 },
      uLens:    { value: 0 },
      uLensLo:  { value: 0 },
      uLensHi:  { value: R_SKY },
      uCursor:  { value: new THREE.Vector2() },
      uFocus:   { value: new THREE.Vector3() },
      uFocusR:  { value: 0 },
      uPickSize: { value: 5 }
    };

    this.materials = {};
    for (const [name, L] of Object.entries(LAYERS)) {
      if (name === 'stars') continue;      // §6.4 — own scene, own scale
      this.materials[name] = new THREE.ShaderMaterial({
        uniforms: {
          ...this.shared,
          // a ring means "you can open this one" — the half-million Milliquas
          // quasars carry no spectrum here, so they stay plain dots and the
          // photograph does not vanish under annotation
          ...(L.pickable ? null : { uRing: { value: 0 } }),
          uColor:    { value: new THREE.Color(L.color) },
          uSize:     { value: L.size },
          uMinPx:    { value: L.min },
          uMaxPx:    { value: L.max },
          uMaxPx3:   { value: L.max3 },
          uOpacity:  { value: L.op },
          uOpacity3: { value: L.op3 }
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false
      });
    }
    this._bounds = new THREE.Sphere(new THREE.Vector3(), R_SKY * 1.3);
  }

  /** Install one parsed chunk (buffer comes straight from the worker, no copy). */
  add(job) {
    const { layer, count, buf, hasTid, path } = job;
    const L = LAYERS[layer];
    if (!L || !this.materials[layer]) return null;

    const pos = new Float32Array(buf, 0, count * 3);
    const sec = new Float32Array(buf, count * 12, count);
    const tid = hasTid ? new BigInt64Array(buf, count * 16, count) : null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.boundingSphere = this._bounds;

    const mesh = new THREE.Points(geo, this.materials[layer]);
    mesh.frustumCulled = false;          // positions are remapped in the shader
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);

    const idx = this.chunks.length;
    let pick = null;
    if (L.pickable && idx < 255) {
      const pm = new THREE.ShaderMaterial({
        uniforms: {
          uMix: this.shared.uMix, uRSky: this.shared.uRSky,
          uPickSize: this.shared.uPickSize, uChunk: { value: idx + 1 },
          uLens: this.shared.uLens, uLensLo: this.shared.uLensLo, uLensHi: this.shared.uLensHi
        },
        vertexShader: PICK_VERT,
        fragmentShader: PICK_FRAG,
        glslVersion: THREE.GLSL3,
        depthWrite: true,
        depthTest: true,
        blending: THREE.NoBlending
      });
      pick = new THREE.Points(geo, pm);
      pick.frustumCulled = false;
      pick.matrixAutoUpdate = false;
      this.pickScene.add(pick);
    }

    const chunk = { layer, path, count, mesh, pick, pos, sec, tid, group: L.group };
    this.chunks.push(chunk);
    this.pointsLoaded += count;
    return chunk;
  }

  setGroupVisible(group, on) {
    for (const c of this.chunks) {
      if (c.group !== group) continue;
      c.mesh.visible = on;
      if (c.pick) c.pick.visible = on;
    }
  }

  /**
   * Per-frame uniform refresh. Allocates nothing.
   * @param standoff camera distance from its focus, Mpc — sets both the exposure
   *        reference and the density gain (see GAIN3_* in config.js).
   * @param ring 0..1 — how much the dots read as open rings instead of discs.
   */
  frame(atten, dpr, standoff, ring, focus) {
    const s = this.shared;
    s.uAtten.value = atten;
    s.uDpr.value = dpr;
    s.uNearRef.value = Math.min(3000, Math.max(120, standoff));
    s.uGain3.value = Math.min(GAIN3_MAX, Math.max(1, Math.pow(GAIN3_REF / Math.max(1, standoff), GAIN3_POW)));
    s.uRing.value = ring;
    const far = focus.x || focus.y || focus.z;   // origin focus = the whole-cone view
    s.uFocusR.value = far ? standoff * 0.85 : 0;
    if (far) s.uFocus.value.copy(focus);
  }

  setLens(on, loMpc = 0, hiMpc = R_SKY) {
    this.shared.uLens.value = on ? 1 : 0;
    this.shared.uLensLo.value = Math.max(0, loMpc);
    this.shared.uLensHi.value = Math.max(loMpc + 1, hiMpc);
  }

  set mix(u) { this.shared.uMix.value = u; }
  get mix() { return this.shared.uMix.value; }

  /**
   * True comoving position, independent of the unfold — which is what a fly-to
   * has to target: double-clicking a dot in photo mode means "take me to that
   * galaxy", and in photo mode the dot is painted 9 Gpc away on the sky sphere
   * no matter where it actually is.
   */
  truePos(ci, pi, out) {
    const c = this.chunks[ci];
    return out.set(c.pos[pi * 3], c.pos[pi * 3 + 1], c.pos[pi * 3 + 2]);
  }
}
