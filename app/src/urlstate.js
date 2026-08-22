// Every view is a permalink (§6.6). The hash carries the camera state vector
// plus which layers are showing.
import { STAGE, FOV_PHOTO_START } from './config.js';

const r = (v, n = 3) => Number(v.toFixed(n));

export function readHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return null;
  const p = new URLSearchParams(h);
  if (!p.has('ra')) return null;
  const num = (k, d) => (p.has(k) ? parseFloat(p.get(k)) : d);
  return {
    ra: num('ra', 194.9), dec: num('dec', 28), fov: num('fov', FOV_PHOTO_START),
    u: num('u', 0), dist: num('d', 0), oyaw: num('oy', 0), opitch: num('op', 0),
    fx: num('fx', 0), fy: num('fy', 0), fz: num('fz', 0),
    stage: num('st', STAGE.PHOTO) | 0,
    photo: p.get('ph') !== '0',
    lens: p.get('lens') === '1',
    lookback: num('lt', 5),
    off: (p.get('off') || '').split(',').filter(Boolean)
  };
}

let last = '';
export function writeHash(rig, photoOn, offGroups, lensOn = false, lookback = 5) {
  const s = rig.st;
  const p = [`ra=${r(s.ra)}`, `dec=${r(s.dec)}`, `fov=${r(s.fov, 2)}`, `u=${r(s.u, 3)}`];
  if (s.dist) p.push(`d=${r(s.dist, 1)}`);
  if (s.oyaw) p.push(`oy=${r(s.oyaw, 3)}`);
  if (s.opitch) p.push(`op=${r(s.opitch, 3)}`);
  if (s.fx || s.fy || s.fz) p.push(`fx=${r(s.fx, 1)}`, `fy=${r(s.fy, 1)}`, `fz=${r(s.fz, 1)}`);
  if (rig.stage !== STAGE.PHOTO) p.push(`st=${rig.stage}`);
  if (!photoOn) p.push('ph=0');
  if (lensOn) p.push('lens=1', `lt=${r(lookback, 3)}`);
  if (offGroups.length) p.push(`off=${offGroups.join(',')}`);
  const h = '#' + p.join('&');
  if (h === last) return;
  last = h;
  history.replaceState(null, '', h);
}
