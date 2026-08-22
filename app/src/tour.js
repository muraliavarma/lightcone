// Tour (§6.7). Each stop is just a target for the camera's state vector, so a
// 2D look and a cone view are the same code path — the camera eases, never cuts.
import { STAGE, FOV_3D, DEPTH_BACK, REDUCED_MOTION } from './config.js';
import { dcOfZ, raDecToVec } from './cosmo.js';
import * as THREE from '../vendor/three/three.module.js';

const _v = new THREE.Vector3();

export class Tour {
  constructor(rig, dom, onStage) {
    this.rig = rig;
    this.onStage = onStage;
    this.stops = [];
    this.i = -1;
    this.active = false;
    this.card = dom.card;
    this.step = dom.step;
    this.title = dom.title;
    this.text = dom.text;
    dom.next.addEventListener('click', () => this.go(this.i + 1));
    dom.prev.addEventListener('click', () => this.go(this.i - 1));
    dom.exit.addEventListener('click', () => this.stop());
    addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.key === 'Escape') { this.stop(); e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === ' ') { this.go(this.i + 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { this.go(this.i - 1); e.preventDefault(); }
    });
  }

  async load(root) {
    try {
      const res = await fetch(`${root}/tours.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      this.stops = j.stops || [];
    } catch (e) {
      console.warn('[lightcone] tours.json unavailable:', e.message);
      this.stops = [];
    }
    return this.stops.length;
  }

  toggle() { this.active ? this.stop() : this.start(); }

  start() {
    if (!this.stops.length) return;
    this.active = true;
    this.card.hidden = false;
    this.go(0);
  }

  stop() {
    this.active = false;
    this.i = -1;
    this.card.hidden = true;
    if (this.onStage) this.onStage();
  }

  go(i) {
    if (!this.stops.length) return;
    if (i < 0) i = 0;
    if (i >= this.stops.length) { this.stop(); return; }
    this.i = i;
    if (this.onGo) this.onGo();
    const s = this.stops[i];
    this.step.textContent = `${i + 1} / ${this.stops.length}`;
    this.title.textContent = s.title || '';
    this.text.textContent = s.text || '';

    const rig = this.rig;
    const dur = REDUCED_MOTION ? 0 : (i === 0 ? 900 : 1500);

    if (s.mode === '2d') {
      rig.stage = STAGE.PHOTO;
      rig.released = false;
      rig.fovPhoto = s.fov || 30;
      rig.goTo({ ra: s.ra, dec: s.dec, fov: rig.fovPhoto, u: 0, dist: 0,
                 oyaw: 0, opitch: 0, fx: 0, fy: 0, fz: 0 }, dur);
    } else {
      // fly to the structure itself and view it broadside: a ~55° side angle puts
      // the line of sight from Earth across the screen, so redshift-space
      // elongation (the finger of god) reads as length instead of foreshortening
      const D = s.z != null ? dcOfZ(s.z) : 0;
      raDecToVec(s.ra, s.dec, _v).multiplyScalar(D);
      // Stand off ~0.6× the structure's own distance. The viewing angle depends
      // on what the stop is about: a nearby cluster is about redshift-space
      // elongation, which only reads as length from nearly broadside (oyaw ≈ 1.3
      // rad off the Earth sight line) — Coma's ~85 Mpc finger then fills the
      // frame. A stop out at the quasars is about how few and how far they are;
      // swing that far off-axis and you leave the survey cone entirely, so stay
      // near the sight line and look out through the whole shell.
      // Deep stops sit ~6 Gpc out; standing 4 Gpc off leaves a near-black frame.
      // Stand much closer and look out through the shell instead.
      const dist = D > 1500 ? 2400 : Math.max(60, Math.min(4200, D * 0.62));
      const oyaw = D > 1500 ? 0.45 : 1.28;
      rig.stage = STAGE.FREE;
      rig.released = true;
      rig.goTo({ ra: s.ra, dec: s.dec, u: 1, fov: FOV_3D, dist,
                 oyaw, opitch: 0.06, fx: _v.x, fy: _v.y, fz: _v.z }, dur);
    }
    if (this.onStage) this.onStage();
  }
}

export { DEPTH_BACK };
