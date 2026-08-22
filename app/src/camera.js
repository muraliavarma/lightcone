// The three-stage camera (§6.1). One continuous perspective camera, no cuts.
//
//   stage 0 PHOTO     camera at the origin, narrow FOV, sky sphere + dots at R_SKY
//   stage 1 ANCHORED  u:0→1 unfolds the dots to their true xyz while the camera
//                     dollies straight back along the same view axis and the FOV
//                     widens — the patch you were looking at stays dead centre
//                     and grows a third dimension. Drag = clamped head parallax.
//   stage 2 FREE      clamp eased off: full orbit + wheel dolly about a focus.
//
// Everything the renderer needs is derived from a small state vector, and any
// transition is one tween over that vector — which is also how the tour and the
// permalink drive the camera.
import * as THREE from '../vendor/three/three.module.js';
import {
  STAGE, R_SKY, FOV_PHOTO_START, FOV_MIN, FOV_MAX, FOV_3D, DEPTH_BACK,
  UNFOLD_MS, ORBIT_CLAMP, RELEASE_HOLD_MS, REDUCED_MOTION
} from './config.js';
import { raDecToVec } from './cosmo.js';

const WORLD_UP = new THREE.Vector3(0, 0, 1);   // equatorial north
const ALT_UP = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;
const smooth = (t) => t * t * (3 - 2 * t);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// tweened scalar fields of the state vector
const FIELDS = ['u', 'fov', 'dist', 'oyaw', 'opitch', 'ra', 'dec', 'fx', 'fy', 'fz'];

export class CameraRig {
  constructor(canvas) {
    this.canvas = canvas;
    this.camera = new THREE.PerspectiveCamera(FOV_PHOTO_START, 1, 0.2, 40000);

    this.st = {
      u: 0, fov: FOV_PHOTO_START, dist: 0, oyaw: 0, opitch: 0,
      ra: 194.9, dec: 28.0, fx: 0, fy: 0, fz: 0
    };
    this.stage = STAGE.PHOTO;
    this.fovPhoto = FOV_PHOTO_START;
    this.released = false;
    this.tw = null;
    this.dirty = true;
    this.onChange = null;
    this.onDoubleClick = null;

    // scratch — the render loop must never allocate
    this._dir = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._u2 = new THREE.Vector3();
    this._off = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._tgt = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._focus = new THREE.Vector3();

    this._drag = null;
    this._satur = 0;
    this._bind();
  }

  // ---------------------------------------------------------------- state

  get focus() { return this._focus.set(this.st.fx, this.st.fy, this.st.fz); }

  setFocus(v) { this.st.fx = v.x; this.st.fy = v.y; this.st.fz = v.z; this.dirty = true; }

  /** Tween the state vector. dur 0 (or reduced motion) = jump cut. */
  goTo(target, dur = UNFOLD_MS, onEnd) {
    if (REDUCED_MOTION) dur = 0;
    const from = {};
    for (const k of FIELDS) from[k] = this.st[k];
    const to = { ...from, ...target };
    // shortest way round in RA
    let d = to.ra - from.ra;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    to.ra = from.ra + d;
    if (dur <= 0) {
      for (const k of FIELDS) this.st[k] = to[k];
      this.st.ra = ((this.st.ra % 360) + 360) % 360;
      this.tw = null;
      this.dirty = true;
      if (onEnd) onEnd();
      return;
    }
    this.tw = { t0: performance.now(), dur, from, to, onEnd };
  }

  /** Stage 1 → 2. */
  unfold() {
    this.stage = STAGE.ANCHORED;
    this.released = false;
    this.goTo({ u: 1, fov: FOV_3D, dist: DEPTH_BACK, fx: 0, fy: 0, fz: 0 }, UNFOLD_MS);
    this._emit();
  }

  /** Back to stage 1, still pointing at the same patch (§6.1). */
  home() {
    const s = this.st;
    // if we flew somewhere, "the same patch" is the direction we were looking at
    if (s.fx || s.fy || s.fz) {
      const r = Math.hypot(s.fx, s.fy, s.fz);
      if (r > 1e-3) {
        let ra = Math.atan2(s.fy, s.fx) / DEG;
        if (ra < 0) ra += 360;
        s.ra = ra;
        s.dec = Math.asin(clamp(s.fz / r, -1, 1)) / DEG;
      }
    }
    this.stage = STAGE.PHOTO;
    this.released = false;
    this.goTo({ u: 0, fov: this.fovPhoto, dist: 0, oyaw: 0, opitch: 0, fx: 0, fy: 0, fz: 0 }, UNFOLD_MS);
    this._emit();
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.stage = STAGE.FREE;
    this._emit();
  }

  focusOn(v, dist) {
    this.release();
    const d = dist != null ? dist : Math.max(8, Math.min(900, v.length() * 0.22));
    this.goTo({ fx: v.x, fy: v.y, fz: v.z, dist: d, u: 1, fov: FOV_3D }, 700);
  }

  // ---------------------------------------------------------------- frame

  update(now) {
    if (this.tw) {
      const k = clamp((now - this.tw.t0) / this.tw.dur, 0, 1);
      const e = smooth(k);
      for (const f of FIELDS) this.st[f] = this.tw.from[f] + (this.tw.to[f] - this.tw.from[f]) * e;
      this.dirty = true;
      if (k >= 1) {
        const cb = this.tw.onEnd;
        this.st.ra = ((this.st.ra % 360) + 360) % 360;
        this.tw = null;
        if (cb) cb();
        this._emit();
      }
    }
    if (!this.dirty) return false;
    this.dirty = false;

    const s = this.st;
    raDecToVec(s.ra, s.dec, this._dir);
    this._b.copy(this._dir).negate();
    this._r.crossVectors(this._dir, WORLD_UP);
    if (this._r.lengthSq() < 1e-10) this._r.crossVectors(this._dir, ALT_UP);
    this._r.normalize();
    this._u2.crossVectors(this._b, this._r).normalize();

    const co = Math.cos(s.opitch), so = Math.sin(s.opitch);
    const cy = Math.cos(s.oyaw), sy = Math.sin(s.oyaw);
    this._off.set(0, 0, 0)
      .addScaledVector(this._b, co * cy)
      .addScaledVector(this._r, co * sy)
      .addScaledVector(this._u2, so);

    this._eye.set(s.fx, s.fy, s.fz).addScaledVector(this._off, s.dist);
    this._tgt.copy(this._eye).addScaledVector(this._off, -1);
    const up = Math.abs(this._off.dot(WORLD_UP)) > 0.999 ? ALT_UP : WORLD_UP;
    this._m.lookAt(this._eye, this._tgt, up);

    const cam = this.camera;
    cam.position.copy(this._eye);
    cam.quaternion.setFromRotationMatrix(this._m);
    if (cam.fov !== s.fov) { cam.fov = s.fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    return true;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** Point-size attenuation factor for the shaders (CSS px). */
  atten(hCss) { return (hCss * 0.5) / Math.tan(this.st.fov * 0.5 * DEG); }

  /** Camera distance from the Milky Way, Mpc. */
  homeDist() { return this.camera.position.length(); }

  // ---------------------------------------------------------------- input

  _emit() { if (this.onChange) this.onChange(); }

  _bind() {
    const el = this.canvas;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      this._drag = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
      this._satur = 0;
      this.tw = null;
    });

    el.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      const h = el.clientHeight || 800;
      const s = this.st;

      if (this.stage === STAGE.PHOTO && s.u < 0.5) {
        // grab the sky: RA runs east-left, so dragging right raises RA
        const perPx = s.fov / h;
        const cd = Math.max(0.08, Math.cos(s.dec * DEG));
        s.ra = ((s.ra + dx * perPx / cd) % 360 + 360) % 360;
        s.dec = clamp(s.dec + dy * perPx, -89.9, 89.9);
      } else {
        const k = 0.0045;
        const lim = this.released ? Infinity : ORBIT_CLAMP * s.u;
        const wantY = s.oyaw - dx * k * (this.released ? 1 : s.u);
        const wantP = s.opitch + dy * k * (this.released ? 1 : s.u);
        s.oyaw = this.released ? wantY : clamp(wantY, -lim, lim);
        s.opitch = clamp(this.released ? wantP : clamp(wantP, -lim, lim), -1.45, 1.45);
        // sustained drag at the clamp eases it off (§6.1 stage 3)
        if (!this.released && lim > 0.01) {
          const at = Math.abs(s.oyaw) >= lim - 1e-4 || Math.abs(s.opitch) >= lim - 1e-4;
          const pushing = at && (Math.abs(wantY) > lim || Math.abs(wantP) > lim);
          this._satur = pushing ? this._satur + 16 : 0;
          if (this._satur > RELEASE_HOLD_MS) this.release();
        }
      }
      this.dirty = true;
      this._emit();
    });

    const end = (e) => {
      const d = this._drag;
      this._drag = null;
      this._satur = 0;
      if (d && d.moved < 4 && this.onClick) this.onClick(e);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => { this._drag = null; });

    el.addEventListener('dblclick', (e) => { if (this.onDoubleClick) this.onDoubleClick(e); });

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const s = this.st;
      this.tw = null;
      if (this.stage === STAGE.PHOTO && s.u < 0.5) {
        s.fov = clamp(s.fov * Math.exp(e.deltaY * 0.0016), FOV_MIN, FOV_MAX);
        this.fovPhoto = s.fov;
      } else {
        const lo = this.released ? 0.05 : DEPTH_BACK * 0.06;
        const hi = this.released ? 30000 : DEPTH_BACK * 26;
        s.dist = clamp(s.dist * Math.exp(e.deltaY * 0.0014), lo, hi);
      }
      this.dirty = true;
      this._emit();
    }, { passive: false });
  }
}

export { R_SKY };
