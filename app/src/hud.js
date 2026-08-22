// HUD (§6.6). Near-monochrome, mono readouts, brass only where you can act.
import { STAGE, GROUPS, QUALITY } from './config.js';
import { fmtRa, fmtDec, zOfDc, MPC_TO_MLY } from './cosmo.js';

export class Hud {
  constructor(handlers) {
    this.h = handlers;
    this.readout = document.getElementById('readout');
    this.rPoints = document.getElementById('rPoints');
    this.rFps = document.getElementById('rFps');
    this.imgSrc = document.getElementById('imgSrc');
    this.hint = document.getElementById('hint');
    this.tipEl = document.getElementById('tip');
    this.mPhoto = document.getElementById('mPhoto');
    this.mDepth = document.getElementById('mDepth');
    this.btnFree = document.getElementById('btnFree');
    this.boot = document.getElementById('boot');
    this.chipEpoch = document.getElementById('chipEpoch');
    this.epochControl = document.getElementById('epochControl');
    this.epochRange = document.getElementById('epochRange');
    this.epochOut = document.getElementById('epochOut');

    this.off = new Set();
    this.photo = true;
    this.lens = false;
    this.lookback = Number(this.epochRange.value) / 1000;
    this._frames = 0; this._t0 = performance.now(); this._fps = 0;
    this._lastRO = '';

    for (const g of GROUPS) {
      const b = document.querySelector(`.chip[data-group="${g.id}"]`);
      if (!b) continue;
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        if (on) this.off.delete(g.id); else this.off.add(g.id);
        this.h.onGroup(g.id, on);
        this.dismissHint();
      });
    }
    const cp = document.getElementById('chipPhoto');
    cp.addEventListener('click', () => {
      this.photo = cp.getAttribute('aria-pressed') !== 'true';
      cp.setAttribute('aria-pressed', String(this.photo));
      this.h.onPhoto(this.photo);
    });
    document.getElementById('chipTour').addEventListener('click', () => this.h.onTour());
    this.mPhoto.addEventListener('click', () => { this.h.onMode(0); this.dismissHint(); });
    this.mDepth.addEventListener('click', () => { this.h.onMode(1); this.dismissHint(); });
    document.getElementById('btnHome').addEventListener('click', () => { this.h.onHome(); this.dismissHint(); });
    this.btnFree.addEventListener('click', () => this.h.onFree());
    this.chipEpoch.addEventListener('click', () => {
      this.setLensState(!this.lens, this.lookback);
      this.h.onLens(this.lens, this.lookback);
      this.dismissHint();
    });
    this.epochRange.addEventListener('input', () => {
      this.lookback = Number(this.epochRange.value) / 1000;
      this._setEpochText();
      this.h.onLens(true, this.lookback);
    });
    document.getElementById('epochClose').addEventListener('click', () => {
      this.setLensState(false, this.lookback);
      this.h.onLens(false, this.lookback);
    });

    if (innerWidth <= 820 || matchMedia('(pointer: coarse)').matches) {
      this.hint.innerHTML = 'drag to look around · pinch to zoom · tap <b>Depth · 3D</b> to unfold the sky';
    }
    this.rPoints.parentElement.title = QUALITY === 'lite'
      ? 'Mobile-optimized view; add ?quality=full to load all points' : 'Full-resolution catalog view';
    this._setEpochText();
    this._hintTimer = setTimeout(() => this.dismissHint(), 11000);
  }

  setGroups(offList) {
    this.off = new Set(offList);
    for (const g of GROUPS) {
      const b = document.querySelector(`.chip[data-group="${g.id}"]`);
      if (b) b.setAttribute('aria-pressed', String(!this.off.has(g.id)));
    }
  }

  setPhotoChip(on) {
    this.photo = on;
    document.getElementById('chipPhoto').setAttribute('aria-pressed', String(on));
  }

  get offGroups() { return [...this.off]; }

  setLensState(on, lookback = this.lookback) {
    this.lens = !!on;
    this.lookback = Math.max(0, Math.min(12.8, Number(lookback) || 0));
    this.epochRange.value = String(Math.round(this.lookback * 1000));
    this.chipEpoch.setAttribute('aria-pressed', String(this.lens));
    this.chipEpoch.setAttribute('aria-expanded', String(this.lens));
    this.epochControl.hidden = !this.lens;
    this._setEpochText();
  }

  _setEpochText() {
    const t = this.lookback;
    const text = t < 1
      ? `${Math.round(t * 1000)} Myr ago · ±450 Myr`
      : `${t.toFixed(t < 10 ? 2 : 1)} Gyr ago · ±0.45`;
    this.epochOut.textContent = text;
    this.epochRange.setAttribute('aria-valuetext', text);
  }

  dismissHint() {
    clearTimeout(this._hintTimer);
    if (this.hint && !this.hint.classList.contains('gone')) this.hint.classList.add('gone');
  }

  bootDone() {
    if (!this.boot || this.boot.classList.contains('gone')) return;
    this.boot.classList.add('gone');
    setTimeout(() => this.boot.remove(), 700);
  }

  setMode(stage, u) {
    const photo = stage === STAGE.PHOTO && u < 0.5;
    this.mPhoto.classList.toggle('on', photo);
    this.mDepth.classList.toggle('on', !photo);
    this.mPhoto.setAttribute('aria-pressed', String(photo));
    this.mDepth.setAttribute('aria-pressed', String(!photo));
    this.btnFree.classList.toggle('hidden', stage !== STAGE.ANCHORED);
  }

  setPoints(n) { this.rPoints.textContent = n.toLocaleString(); }
  setSource(s) { this.imgSrc.textContent = s ? `imagery: ${s}` : ''; }

  tip(x, y, text) {
    if (!text) { this.tipEl.hidden = true; return; }
    this.tipEl.hidden = false;
    this.tipEl.textContent = text;
    this.tipEl.style.left = `${x}px`;
    this.tipEl.style.top = `${y}px`;
  }

  /** Mode-dependent bottom-left readout (§6.6). */
  setReadout(rig) {
    const s = rig.st;
    let t;
    if (s.u < 0.5) {
      t = `RA  ${fmtRa(s.ra)}\nDec ${fmtDec(s.dec)}\nFOV ${s.fov.toFixed(2)}°`;
    } else {
      const d = rig.homeDist();
      const z = zOfDc(d);
      t = `from home  ${Math.round(d).toLocaleString()} Mpc\n           ${(d * MPC_TO_MLY / 1000).toFixed(2)} Gly\nz at camera ${isFinite(z) ? z.toFixed(4) : '—'}`;
    }
    if (t !== this._lastRO) { this._lastRO = t; this.readout.textContent = t; }
  }

  tick(now) {
    this._frames++;
    if (now - this._t0 >= 500) {
      this._fps = Math.round((this._frames * 1000) / (now - this._t0));
      this._frames = 0; this._t0 = now;
      this.rFps.textContent = this._fps;
    }
  }
}
