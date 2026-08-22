// Live imagery fetch (§6.3), shared by the sky's tangent quad and the panel photo.
//
// Only the two CORS-open services from §2 are ever touched: legacysurvey.org's
// jpeg-cutout for DR11, and CDS hips2fits for DSS2 outside the DR11 footprint.
// The {a-d}.legacysurvey.org tile servers have no CORS and are never used.
//
// Out-of-footprint detection: the cutout service answers HTTP 200 with a
// featureless frame — flat grey 32, not black. §2 gives its size as ~1652 B,
// which identifies it at size=256, but the same empty frame at size=1536
// compresses to ~37 kB, so the byte test alone silently accepts a grey
// rectangle. What actually separates the two is variation: measured against
// every DR11 field checked, a blank answer has a 24×24 luminance range of
// exactly 0 while the flattest real field still ranges 11. Bytes first (free),
// pixels second (one 24×24 downscale).
import { CUTOUT, HIPS2FITS, BLANK_BYTES } from './config.js';

export const SRC_DR11 = 'Legacy Surveys DR11';
export const SRC_DSS2 = 'DSS2 (outside DR11 footprint)';

let probe = null, pctx = null;
function pixelsAreBlank(img) {
  try {
    if (!probe) {
      probe = document.createElement('canvas');
      probe.width = probe.height = 24;
      pctx = probe.getContext('2d', { willReadFrequently: true });
    }
    pctx.clearRect(0, 0, 24, 24);
    pctx.drawImage(img, 0, 0, 24, 24);
    const d = pctx.getImageData(0, 0, 24, 24).data;
    let hi = 0, lo = 255;
    for (let i = 0; i < d.length; i += 4) {
      const m = Math.max(d[i], d[i + 1], d[i + 2]);
      if (m > hi) hi = m;
      if (m < lo) lo = m;
    }
    return hi - lo <= 2;
  } catch (e) {
    return false;                 // never reject imagery because the probe failed
  }
}

function decode(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

async function get(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.blob() : null;
  } catch (e) {
    return null;
  }
}

/**
 * @param {number} fov  square field of view in degrees
 * @param {number} px   pixels per side
 * @returns {Promise<{img:HTMLImageElement, url:string, source:string}|null>}
 *          `url` is an object URL the caller owns and must revoke.
 */
export async function fetchCutout(ra, dec, fov, px) {
  const pixscale = (fov * 3600) / px;
  const blob = await get(
    `${CUTOUT}?ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&layer=ls-dr11` +
    `&pixscale=${pixscale.toFixed(4)}&size=${Math.round(px)}`);

  if (blob && blob.size >= BLANK_BYTES) {
    const got = await decode(blob);
    if (got && !pixelsAreBlank(got.img)) return { ...got, source: SRC_DR11 };
    if (got) URL.revokeObjectURL(got.url);
  }

  const dss = await get(
    `${HIPS2FITS}?hips=CDS%2FP%2FDSS2%2Fcolor&ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}` +
    `&fov=${fov.toFixed(6)}&width=${Math.round(px)}&height=${Math.round(px)}` +
    `&projection=TAN&format=jpg`);
  if (!dss || dss.size < 800) return null;
  const got = await decode(dss);
  return got ? { ...got, source: SRC_DSS2 } : null;
}
