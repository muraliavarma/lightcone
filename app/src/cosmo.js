// Cosmology lookups. The manifest ships z→D_C and z→lookback tables (§4);
// everything here is table interpolation, so the client never re-derives cosmology.
import { COSMO_FALLBACK, C_KMS } from './config.js';

let ZD = null;   // [[z, Mpc], ...]
let ZT = null;   // [[z, Gyr], ...]
let H0 = COSMO_FALLBACK.H0;

export function initCosmo(manifest) {
  ZD = manifest.z_to_dc || null;
  ZT = manifest.z_to_tlb || null;
  if (manifest.cosmology && manifest.cosmology.H0) H0 = manifest.cosmology.H0;
}

export const hubble = () => H0;

function lerpTable(tbl, x, col) {
  if (!tbl || tbl.length < 2) return NaN;
  if (x <= tbl[0][0]) return tbl[0][col];
  const last = tbl.length - 1;
  if (x >= tbl[last][0]) return tbl[last][col];
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tbl[mid][0] < x) lo = mid; else hi = mid;
  }
  const t = (x - tbl[lo][0]) / (tbl[hi][0] - tbl[lo][0]);
  return tbl[lo][col] + t * (tbl[hi][col] - tbl[lo][col]);
}

/** Comoving distance in Mpc for redshift z. */
export const dcOfZ = (z) => lerpTable(ZD, z, 1);

/** Lookback time in Gyr for redshift z. */
export const tlbOfZ = (z) => lerpTable(ZT, z, 1);

/** Invert D_C → z (the table is monotonic in both columns). */
export function zOfDc(d) {
  if (!ZD || ZD.length < 2) return NaN;
  if (d <= 0) return 0;
  const last = ZD.length - 1;
  if (d >= ZD[last][1]) return ZD[last][0];
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ZD[mid][1] < d) lo = mid; else hi = mid;
  }
  const t = (d - ZD[lo][1]) / (ZD[hi][1] - ZD[lo][1]);
  return ZD[lo][0] + t * (ZD[hi][0] - ZD[lo][0]);
}

export const MPC_TO_MLY = 3.26156;

/** Human phrasing for lookback time (§6.5). */
export function lookbackPhrase(gyr) {
  if (!isFinite(gyr)) return '—';
  if (gyr < 0.001) return `${Math.round(gyr * 1e9).toLocaleString()} years`;
  if (gyr < 1) return `${Math.round(gyr * 1000)} million years`;
  return `${gyr.toFixed(2)} billion years`;
}

/** Recession speed from redshift, for the nearby layer's plain-language line. */
export const czOfZ = (z) => z * C_KMS;

/** xyz (Mpc, equatorial cartesian) → {ra, dec} in degrees. §4 frame. */
export function xyzToRaDec(x, y, z) {
  const r = Math.hypot(x, y, z) || 1;
  let ra = Math.atan2(y, x) * 180 / Math.PI;
  if (ra < 0) ra += 360;
  const dec = Math.asin(Math.max(-1, Math.min(1, z / r))) * 180 / Math.PI;
  return { ra, dec };
}

/** {ra, dec} degrees → unit vector, written into `out`. */
export function raDecToVec(raDeg, decDeg, out) {
  const ra = raDeg * Math.PI / 180, dec = decDeg * Math.PI / 180;
  const cd = Math.cos(dec);
  out.set(cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec));
  return out;
}

export function fmtRa(ra) {
  const h = ((ra % 360) + 360) % 360 / 15;
  const hh = Math.floor(h), m = (h - hh) * 60, mm = Math.floor(m);
  return `${String(hh).padStart(2, '0')}h${String(mm).padStart(2, '0')}m${(m - mm) * 60 < 10 ? '0' : ''}${((m - mm) * 60).toFixed(1)}s`;
}

export function fmtDec(dec) {
  const s = dec < 0 ? '−' : '+';
  const a = Math.abs(dec), d = Math.floor(a), m = (a - d) * 60, mm = Math.floor(m);
  return `${s}${String(d).padStart(2, '0')}°${String(mm).padStart(2, '0')}′${((m - mm) * 60).toFixed(0).padStart(2, '0')}″`;
}
