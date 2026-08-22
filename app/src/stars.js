// Dual scale (§6.4). The stars layer is in PARSECS, so it lives in its own
// scene with its own camera: same orientation and FOV as the cosmic camera, but
// its position scaled by PC_PER_MPC. Walk more than ~40 Mpc from home and the
// local ball fades out; come back and the sky you stand under returns.
import * as THREE from '../vendor/three/three.module.js';
import { LAYERS, PC_PER_MPC, STAR_FADE_MPC } from './config.js';

const VERT = /* glsl */`
uniform float uAtten, uDpr, uAlpha;
attribute float mag;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 1.0);
  float bright = clamp((8.2 - mag) / 8.0, 0.05, 1.0);
  gl_PointSize = clamp((0.55 + bright * 2.6) * uAtten / 900.0, 0.7, 5.0) * uDpr;
  vA = uAlpha * (0.25 + 0.75 * bright) * clamp(1.0 - dist / 2600.0, 0.05, 1.0);
}`;

const FRAG = /* glsl */`
precision mediump float;
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  gl_FragColor = vec4(uColor, vA * smoothstep(0.25, 0.02, r2));
}`;

export class StarField {
  constructor() {
    this.scene = new THREE.Scene();
    // ATHYG reaches ~77 kpc (the Magellanic Clouds' outliers), so the far plane
    // has to clear that or the sky loses stars at wide FOV.
    this.camera = new THREE.PerspectiveCamera(4, 1, 0.05, 200000);
    this.alpha = 1;
    this.enabled = true;
    this.count = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtten: { value: 800 }, uDpr: { value: 1 }, uAlpha: { value: 1 },
        uColor: { value: new THREE.Color(LAYERS.stars.color) }
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false
    });
    this._bounds = new THREE.Sphere(new THREE.Vector3(), 1e5);
  }

  add(job) {
    const { count, buf } = job;
    const pos = new Float32Array(buf, 0, count * 3);
    const mag = new Float32Array(buf, count * 12, count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
    geo.boundingSphere = this._bounds;
    const m = new THREE.Points(geo, this.material);
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    this.scene.add(m);
    this.count += count;
  }

  setEnabled(on) { this.enabled = on; }

  /** Mirror the cosmic camera at parsec scale and crossfade by distance. */
  sync(cosmic, atten, dpr) {
    const d = cosmic.position.length();
    this.alpha = 1 - smoothstep(STAR_FADE_MPC * 0.5, STAR_FADE_MPC, d);
    this.material.uniforms.uAlpha.value = this.alpha;
    this.material.uniforms.uAtten.value = atten;
    this.material.uniforms.uDpr.value = dpr;
    const c = this.camera;
    c.position.copy(cosmic.position).multiplyScalar(PC_PER_MPC);
    c.quaternion.copy(cosmic.quaternion);
    if (c.fov !== cosmic.fov || c.aspect !== cosmic.aspect) {
      c.fov = cosmic.fov; c.aspect = cosmic.aspect; c.updateProjectionMatrix();
    }
    c.updateMatrixWorld();
    return this.enabled && this.alpha > 0.004 && this.count > 0;
  }
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
