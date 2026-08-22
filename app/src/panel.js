// Drill-down panel (§6.5): the real photograph, the measured numbers, and the
// real spectrum pulled live from NOIRLab SPARCL.
//
// TARGETID hazard (§2a): DESI TARGETIDs exceed 2^53, so they never touch a JS
// Number. They live in a BigInt64Array, get stringified once, and go to SPARCL
// as a JSON *string* specid (verified accepted).
import {
  SPARCL, VIEWER, LAYERS, HAS_SPECTRUM, LINES_GAL_EM, LINES_GAL_ABS, LINES_QSO
} from './config.js';
import { fetchCutout } from './cutout.js';
import { dcOfZ, tlbOfZ, zOfDc, lookbackPhrase, fmtRa, fmtDec, MPC_TO_MLY, czOfZ } from './cosmo.js';

const NSPEC = 7781;                     // grid is exactly 3600.0 + 0.8*i (§2)
const L0 = 3600.0, DL = 0.8;
const CSS = getComputedStyle(document.documentElement);
const tok = (n, f) => (CSS.getPropertyValue(n) || f).trim() || f;

export class Panel {
  constructor(el) {
    this.el = el;
    this.el.inert = true;
    this.el.innerHTML = `
      <button class="pClose" aria-label="Close">×</button>
      <div class="pPhoto"><img alt="" decoding="async"><i class="pCross"></i><span class="pNote"></span></div>
      <h2 class="pTitle"></h2>
      <div class="pClass"></div>
      <dl class="pNums"></dl>
      <p class="pPlain"></p>
      <div class="pSpec">
        <div class="pSpecHead"><span>spectrum</span><span class="pSpecSrc"></span></div>
        <canvas class="pCanvas" width="600" height="340"></canvas>
        <div class="pSpecMsg"></div>
        <p class="pSpecWhy">The labeled fingerprints arrive stretched by ×(1 + z). That shift is what gives this point its depth.</p>
      </div>
      <div class="pActions">
        <button class="pLocate">locate on the photographed sky</button>
        <a class="pLink" target="_blank" rel="noopener">official survey viewer ↗</a>
      </div>`;
    this.img = el.querySelector('.pPhoto img');
    this.cross = el.querySelector('.pCross');
    this.note = el.querySelector('.pNote');
    this.title = el.querySelector('.pTitle');
    this.cls = el.querySelector('.pClass');
    this.nums = el.querySelector('.pNums');
    this.plain = el.querySelector('.pPlain');
    this.canvas = el.querySelector('.pCanvas');
    this.specMsg = el.querySelector('.pSpecMsg');
    this.specSrc = el.querySelector('.pSpecSrc');
    this.specWhy = el.querySelector('.pSpecWhy');
    this.specBox = el.querySelector('.pSpec');
    this.link = el.querySelector('.pLink');
    this.locate = el.querySelector('.pLocate');
    el.querySelector('.pClose').addEventListener('click', () => this.close());
    this.locate.addEventListener('click', () => { if (this.onLocate && this.sel) this.onLocate(this.sel); });
    this.token = 0;
    this.onClose = null;
    this.onLocate = null;
  }

  close() {
    this.token++;
    this.el.classList.remove('open');
    this.el.setAttribute('aria-hidden', 'true');
    this.el.inert = true;
    if (this.onClose) this.onClose();
  }

  get isOpen() { return this.el.classList.contains('open'); }

  /** sel: {layer, ra, dec, z, tidStr|null} */
  open(sel) {
    const me = ++this.token;
    this.sel = sel;
    this.el.classList.add('open');
    this.el.setAttribute('aria-hidden', 'false');
    this.el.inert = false;

    const L = LAYERS[sel.layer] || {};
    const isQso = L.group === 'qso';
    this.title.textContent = sel.tidStr ? `DESI ${sel.tidStr}` : L.label || 'Object';
    if (sel.layer === 'local_cf4') {
      this.cls.textContent = 'Cosmicflows-4 · redshift-independent distance';
    } else if (sel.layer === 'local_2mrs') {
      this.cls.textContent = '2MRS · CMB-frame redshift distance';
    } else if (sel.layer === 'qso_sky') {
      this.cls.textContent = 'Milliquas v8 · spectroscopic redshift';
    } else {
      this.cls.textContent = `${L.label || sel.layer} · DESI DR1`;
    }
    this.cross.style.display = isQso ? 'block' : 'none';

    // The rendered radius is the authoritative map distance. This is essential
    // for Cosmicflows-4, whose whole purpose is to differ from cz/H0 where
    // peculiar velocity is important.
    const dc = Number.isFinite(sel.distance) ? sel.distance : dcOfZ(sel.z);
    const tlb = tlbOfZ(zOfDc(dc));
    const rows = [
      ['redshift z', sel.z.toFixed(5)],
      [sel.layer === 'local_cf4' ? 'direct D' : 'comoving D', `${fmtNum(dc)} Mpc`],
      ['', `${fmtNum(dc * MPC_TO_MLY)} Mly`],
      ['lookback', `${tlb.toFixed(3)} Gyr`],
      ['RA', `${fmtRa(sel.ra)}  (${sel.ra.toFixed(4)}°)`],
      ['Dec', `${fmtDec(sel.dec)}  (${sel.dec.toFixed(4)}°)`]
    ];
    if (sel.layer === 'local_cf4' || sel.layer === 'local_2mrs') {
      rows.push(['CMB velocity', `${Math.round(czOfZ(sel.z)).toLocaleString()} km/s`]);
    }
    this.nums.innerHTML = rows.map(([k, v]) =>
      `<dt>${k}</dt><dd>${v}</dd>`).join('');

    const thing = isQso ? 'quasar' : 'galaxy';
    if (sel.layer === 'local_cf4') {
      this.plain.textContent = `Its distance comes from a redshift-independent indicator in Cosmicflows-4. Local motion can make the redshift disagree. Light left about ${lookbackPhrase(tlb)} ago.`;
    } else if (sel.layer === 'local_2mrs') {
      this.plain.textContent = `Its distance is estimated from a CMB-corrected 2MRS redshift using Hubble's law. Light left about ${lookbackPhrase(tlb)} ago.`;
    } else if (sel.layer === 'qso_sky') {
      this.plain.textContent = `A spectroscopically confirmed quasar catalogued by Milliquas. Light left it ${lookbackPhrase(tlb)} ago; no DESI spectrum is linked to this entry.`;
    } else {
      this.plain.textContent = `Light left this ${thing} ${lookbackPhrase(tlb)} ago.`;
    }

    this.link.href = `${VIEWER}?ra=${sel.ra.toFixed(6)}&dec=${sel.dec.toFixed(6)}&layer=ls-dr11&zoom=13`;

    this._photo(sel, me);

    if (HAS_SPECTRUM.has(sel.layer) && sel.tidStr) {
      this.specBox.style.display = '';
      this._spectrum(sel, me, isQso);
    } else {
      this.specBox.style.display = 'none';
    }
  }

  // ------------------------------------------------------------- photo

  async _photo(sel, me) {
    this.img.removeAttribute('src');
    this.note.textContent = 'loading photo…';
    const px = 256, fov = (px * 0.262) / 3600;         // 0.262″/px — DECam native
    const got = await fetchCutout(sel.ra, sel.dec, fov, px);
    if (me !== this.token) { if (got) URL.revokeObjectURL(got.url); return; }
    if (!got) { this.note.textContent = 'no imagery here'; return; }
    this.img.onload = () => URL.revokeObjectURL(got.url);
    this.img.src = got.url;
    this.note.textContent = got.source;
  }

  // ------------------------------------------------------------ spectrum

  async _spectrum(sel, me, isQso) {
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.specMsg.textContent = 'asking SPARCL for the spectrum…';
    this.specSrc.textContent = '';
    this.specWhy.hidden = true;
    try {
      // targetid → sparcl_id. Body built by hand so the int64 never becomes a Number.
      const findBody = '{"outfields":["sparcl_id"],"search":[["data_release","DESI-DR1"],["specid","'
        + sel.tidStr + '"],["specprimary",1]]}';
      const fr = await fetch(`${SPARCL}/find/?limit=1`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: findBody
      });
      if (!fr.ok) throw new Error(`find HTTP ${fr.status}`);
      const rows = await fr.json();
      const rec = Array.isArray(rows) ? rows.find((r) => r && r.sparcl_id) : null;
      if (me !== this.token) return;
      if (!rec) { this.specMsg.textContent = 'no DESI DR1 spectrum for this target'; return; }

      const sr = await fetch(`${SPARCL}/spectras/?include=flux,model&format=json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([rec.sparcl_id])
      });
      if (!sr.ok) throw new Error(`spectras HTTP ${sr.status}`);
      const out = await sr.json();
      const spec = Array.isArray(out) ? out.find((r) => r && r.flux) : null;
      if (me !== this.token) return;
      if (!spec || !spec.flux) { this.specMsg.textContent = 'spectrum unavailable'; return; }

      this.specMsg.textContent = '';
      this.specSrc.textContent = 'DESI DR1 · SPARCL · 10⁻¹⁷ erg s⁻¹ cm⁻² Å⁻¹';
      this.specWhy.hidden = false;
      this._draw(spec.flux, spec.model, sel.z, isQso);
    } catch (err) {
      if (me !== this.token) return;
      this.specMsg.textContent = 'spectrum unavailable';
      console.warn('[lightcone] spectrum:', err.message);
    }
  }

  _draw(flux, model, z, isQso) {
    const cv = this.canvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const wCss = cv.clientWidth || 320, hCss = 182;
    cv.width = Math.round(wCss * dpr);
    cv.height = Math.round(hCss * dpr);
    cv.style.height = hCss + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, wCss, hCss);

    const n = Math.min(NSPEC, flux.length);
    const sm = boxcar3(flux, n);
    const padL = 6, padR = 6, padT = 24, padB = 18;
    const W = wCss - padL - padR, H = hCss - padT - padB;

    // robust y-range so one cosmic ray doesn't flatten the spectrum
    const lo = pct(sm, 0.01), hi = pct(sm, 0.995);
    const span = Math.max(1e-6, hi - lo);
    const y0 = lo - span * 0.10, y1 = hi + span * 0.14;
    const sy = (v) => padT + H - ((v - y0) / (y1 - y0)) * H;
    const sx = (i) => padL + (i / (n - 1)) * W;

    const gold = tok('--gold', '#D9A84E');
    const dim = tok('--dim', '#7E8AA0');
    const line = tok('--line', '#1B2433');

    // rest-frame lines redshifted into the observed frame (§6.5); labels are
    // laid out on two rows and dropped when both rows are already taken, so a
    // crowded low-z galaxy never turns into a smear of overlapping text
    const lines = isQso ? LINES_QSO : LINES_GAL_EM.concat(LINES_GAL_ABS);
    ctx.save();
    ctx.font = '9px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textBaseline = 'top';
    const rowEnd = [-1e3, -1e3];
    const placed = lines
      .map(([name, lam]) => ({ name, i: (lam * (1 + z) - L0) / DL }))
      .filter((o) => o.i >= 2 && o.i <= n - 3)
      .sort((a, b) => a.i - b.i);
    for (const o of placed) {
      const x = sx(o.i);
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#2E3A4E';
      ctx.beginPath(); ctx.moveTo(x, padT - 2); ctx.lineTo(x, padT + H); ctx.stroke();
      ctx.restore();
      const w = ctx.measureText(o.name).width + 5;
      // clamp inside the plot so a line near 9800 Å doesn't shove its label
      // off the right edge (seen with [O II]/Ca at z ≈ 1.5)
      const lx = Math.min(x + 2, wCss - padR - w);
      const row = lx > rowEnd[0] ? 0 : lx > rowEnd[1] ? 1 : -1;
      if (row < 0) continue;
      rowEnd[row] = lx + w;
      ctx.fillStyle = dim;
      ctx.fillText(o.name, lx, row === 0 ? 0 : 10);
    }
    ctx.restore();

    // baseline
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, sy(0) > padT + H ? padT + H : sy(0));
    ctx.lineTo(padL + W, sy(0) > padT + H ? padT + H : sy(0));
    ctx.stroke();

    poly(ctx, sm, n, sx, sy, W, dim, 0.8, 0.75);      // measured starlight
    poly(ctx, model, n, sx, sy, W, gold, 1.2, 1);     // DESI pipeline model

    ctx.fillStyle = dim;
    ctx.font = '9px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('3600 Å', padL, hCss - 5);
    const lmax = Math.round(L0 + DL * (n - 1));
    ctx.fillText(`${lmax} Å (observed)`, padL + W - 92, hCss - 5);
    ctx.restore && ctx.restore;
  }
}

// ---------------------------------------------------------------- helpers

function poly(ctx, arr, n, sx, sy, W, color, width, alpha) {
  const cols = Math.max(1, Math.round(W));
  const per = n / cols;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * per), b = Math.min(n, Math.floor((c + 1) * per));
    let s = 0, k = 0;
    for (let i = a; i < b; i++) { const v = arr[i]; if (isFinite(v)) { s += v; k++; } }
    if (!k) continue;
    const x = sx(a + (b - a) * 0.5), y = sy(s / k);
    if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function boxcar3(a, n) {
  const o = new Float32Array(n);
  o[0] = a[0]; o[n - 1] = a[n - 1];
  for (let i = 1; i < n - 1; i++) o[i] = (a[i - 1] + a[i] + a[i + 1]) / 3;
  return o;
}

function pct(a, p) {
  const step = Math.max(1, Math.floor(a.length / 2000));
  const s = [];
  for (let i = 0; i < a.length; i += step) if (isFinite(a[i])) s.push(a[i]);
  s.sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
}

function fmtNum(v) {
  if (!isFinite(v)) return '—';
  return v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(v < 10 ? 2 : 1);
}
