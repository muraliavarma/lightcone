// Imagery (§6.3): the all-sky base plate on the inside of the sky sphere, plus
// live Legacy Surveys DR11 cutouts on a tangent quad when you zoom in past 3°.
//
// Only jpeg-cutout and hips2fits are CORS-open (§2) — the {a-d}.legacysurvey.org
// tile servers are NOT usable as WebGL textures and are never touched here.
import * as THREE from '../vendor/three/three.module.js';
import { R_SKY, DETAIL_FOV, CUTOUT_PX, TEX_CACHE, SHOW_GRATICULE } from './config.js';
import { fetchCutout } from './cutout.js';

const DEG = Math.PI / 180;

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Sampling by direction (not by mesh UV) keeps the CAR→equirect mapping in one
// place: RA runs east-left, so u increases as RA decreases, and the plate is
// centred on RA 0 exactly as hips2fits returns it.
const SKY_FRAG = /* glsl */`
precision mediump float;
uniform sampler2D uMap;
uniform float uOpacity, uGrid, uHasMap;
varying vec3 vDir;
const float PI = 3.14159265359;
void main() {
  vec3 d = normalize(vDir);
  float ra = atan(d.y, d.x);
  float dec = asin(clamp(d.z, -1.0, 1.0));
  float u = fract((PI - ra) / (2.0 * PI));
  float v = dec / PI + 0.5;
  vec3 c = uHasMap > 0.5 ? texture2D(uMap, vec2(u, v)).rgb : vec3(0.02, 0.027, 0.043);
  if (uGrid > 0.5) {
    float raDeg = degrees(ra < 0.0 ? ra + 2.0 * PI : ra);
    float decDeg = degrees(dec);
    float gr = min(abs(fract(raDeg / 15.0 + 0.5) - 0.5), abs(fract(decDeg / 10.0 + 0.5) - 0.5));
    c += vec3(0.35, 0.28, 0.14) * smoothstep(0.02, 0.0, gr);
  }
  gl_FragColor = vec4(c, uOpacity);
}`;

export class Sky {
  constructor(scene, root) {
    this.root = root;
    this.enabled = true;
    this.source = '';
    this.onSource = null;

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: null }, uOpacity: { value: 1 },
        uGrid: { value: SHOW_GRATICULE ? 1 : 0 }, uHasMap: { value: 0 }
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: false
    });
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(R_SKY * 1.04, 96, 48), this.mat);
    this.sphere.renderOrder = -10;
    this.sphere.frustumCulled = false;
    scene.add(this.sphere);

    this.quadMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false, depthTest: false, toneMapped: false
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.quadMat);
    this.quad.renderOrder = -9;
    this.quad.frustumCulled = false;
    this.quad.matrixAutoUpdate = false;
    this.quad.visible = false;
    scene.add(this.quad);

    this.cache = new Map();          // key → {tex, src}
    this.cur = null;                 // {ra, dec, fov}
    this.pending = null;
    this.timer = 0;

    this._x = new THREE.Vector3();
    this._y = new THREE.Vector3();
    this._z = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._m = new THREE.Matrix4();

    this._loadBase();
  }

  _loadBase() {
    new THREE.TextureLoader().load(
      `${this.root}/sky_base.jpg`,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.generateMipmaps = false;                  // avoids a seam at RA 180
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.wrapS = THREE.RepeatWrapping;
        this.mat.uniforms.uMap.value = t;
        this.mat.uniforms.uHasMap.value = 1;
      },
      undefined,
      () => console.warn('[lightcone] sky_base.jpg missing — sky sphere stays blank')
    );
  }

  setEnabled(on) {
    this.enabled = on;
    this.sphere.visible = on;
    this.quad.visible = on && !!this.cur;
  }

  /** Photo wall fades to 40% as the field unfolds (§6.1). */
  setMix(u) {
    const o = 1 - 0.6 * u;
    this.mat.uniforms.uOpacity.value = o;
    this.quadMat.opacity = this.quadMat.userData.on ? o : 0;
  }

  /** True when a real photograph is up on the tangent quad (drives §6.3 ring markers). */
  get detailOn() { return this.enabled && !!this.cur && this.quad.visible; }

  /**
   * Called whenever the camera settles; decides if a new cutout is warranted.
   * `aspect` is the viewport aspect — the quad is square, so it has to be sized
   * by the *horizontal* field of view or the frame gets black bars on a wide
   * window.
   */
  update(ra, dec, fov, u, aspect) {
    if (!this.enabled || u > 0.02 || fov >= DETAIL_FOV) {
      if (this.cur) this._clearQuad();
      return;
    }
    const cover = 2 * Math.atan(Math.tan(fov * 0.5 * DEG) * Math.max(1.12, aspect * 1.06)) / DEG;
    const req = Math.min(DETAIL_FOV * 1.9, cover);
    if (this.cur) {
      const sep = angSep(ra, dec, this.cur.ra, this.cur.dec);
      if (sep < this.cur.fov * 0.22 && req > this.cur.fov / 2.4 && req < this.cur.fov * 1.5) return;
    }
    const key = `${ra.toFixed(3)},${dec.toFixed(3)},${req.toFixed(4)}`;
    if (this.pending === key) return;
    this.pending = key;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._fetch(ra, dec, req, key), 320);
  }

  _clearQuad() {
    this.cur = null;
    this.pending = null;
    this.quad.visible = false;
    this.quadMat.userData.on = false;
    this.quadMat.opacity = 0;
    this._setSource('');
  }

  _setSource(s) {
    if (s === this.source) return;
    this.source = s;
    if (this.onSource) this.onSource(s);
  }

  async _fetch(ra, dec, fov, key) {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); this.cache.set(key, hit);   // LRU touch
      this._show(hit.tex, ra, dec, fov, hit.src, key);
      return;
    }
    // wide patches get more texels so the photograph stays sharper than the screen
    const px = fov > 3 ? CUTOUT_PX * 1.5 : CUTOUT_PX;
    const got = await fetchCutout(ra, dec, fov, px);
    if (!got) { this.pending = null; this._setSource('imagery unavailable here'); return; }

    const tex = new THREE.Texture(got.img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    URL.revokeObjectURL(got.url);

    this.cache.set(key, { tex, src: got.source });
    while (this.cache.size > TEX_CACHE) {
      const k = this.cache.keys().next().value;
      const v = this.cache.get(k);
      this.cache.delete(k);
      v.tex.dispose();
    }
    if (this.pending !== key) return;      // camera moved on
    this._show(tex, ra, dec, fov, got.source, key);
  }

  _show(tex, ra, dec, fov, src, key) {
    this.pending = null;
    this.cur = { ra, dec, fov, key };
    this.quadMat.map = tex;
    this.quadMat.needsUpdate = true;
    this.quadMat.userData.on = true;
    this.quadMat.opacity = this.mat.uniforms.uOpacity.value;
    this.quad.visible = this.enabled;
    this._setSource(src);

    // tangent plane at R_SKY: +X is -east (RA rises to the left), +Y is north
    const r = ra * DEG, d = dec * DEG;
    const cr = Math.cos(r), sr = Math.sin(r), cd = Math.cos(d), sd = Math.sin(d);
    this._x.set(sr, -cr, 0);                        // −east
    this._y.set(-sd * cr, -sd * sr, cd);            // north
    this._z.set(-cd * cr, -cd * sr, -sd);           // back toward the observer
    this._p.set(cd * cr * R_SKY, cd * sr * R_SKY, sd * R_SKY);
    const half = R_SKY * Math.tan(fov * 0.5 * DEG);
    this._m.makeBasis(this._x, this._y, this._z);
    this._m.setPosition(this._p);
    this._m.scale(this._s.set(2 * half, 2 * half, 1));
    this.quad.matrix.copy(this._m);
    this.quad.matrixWorldNeedsUpdate = true;
  }
}

function angSep(r1, d1, r2, d2) {
  const a = d1 * DEG, b = d2 * DEG, dr = (r1 - r2) * DEG;
  return Math.acos(Math.max(-1, Math.min(1,
    Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(dr)))) / DEG;
}

