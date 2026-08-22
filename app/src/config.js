// Lightcone — constants, palette, layer table. SPEC.md §6, §8.

export const R_SKY = 9000;             // sky-sphere radius, scene units (= Mpc comoving)
export const FOV_PHOTO_START = 4;      // §6.1 stage 1
export const FOV_MIN = 0.5;
export const FOV_MAX = 60;
export const FOV_3D = 55;              // §6.1 stage 2 target
export const DEPTH_BACK = 420;         // Mpc the camera dollies back during the unfold
export const UNFOLD_MS = 800;          // §6.1
export const ORBIT_CLAMP = 0.5;        // rad, anchored head-parallax (§6.1)
export const RELEASE_HOLD_MS = 300;    // sustained drag at the clamp releases it
// §6.3 asks for a live cutout below 3°; we widen the trigger so the default
// 4° opening view is already real Legacy Surveys imagery rather than a smeared
// all-sky plate. Strictly a superset of the spec's rule.
export const DETAIL_FOV = 5.5;
export const CUTOUT_PX = 1024;
export const TEX_CACHE = 40;           // §6.3 LRU
export const BLANK_BYTES = 2500;       // §2 — out-of-footprint jpeg is ~1652 B
export const STAR_FADE_MPC = 40;       // §6.4 crossfade distance
export const STAR_BALL_PC = 600;       // scene radius the star ball occupies
export const PC_PER_MPC = STAR_BALL_PC / STAR_FADE_MPC;

export const STAGE = { PHOTO: 0, ANCHORED: 1, FREE: 2 };

export const COSMO_FALLBACK = { H0: 67.4, Om: 0.315 };
export const C_KMS = 299792.458;

// §8 layer colors + rendering weight. `group` drives the HUD chips (§6.6).
//
// Two sets of weights, blended by the unfold value u: in 2D you are looking at
// individual objects on the sky, so dots are bright and distinct; in 3D you are
// looking through millions of them at once, so each contributes little and the
// structure emerges from density instead of blowing out to white.
export const LAYERS = {
  stars:    { color: 0xF2EFE7, group: 'stars',  label: 'Star',                 pickable: false, size: 0,   min: 0,    max: 0,   max3: 0,   op: 1.00, op3: 1.00 },
  local:    { color: 0xCFC9BC, group: 'nearby', label: 'Nearby galaxy',        pickable: true,  size: 5.0, min: 1.0,  max: 6.0, max3: 4.4, op: 0.90, op3: 0.30 },
  web_bgs:  { color: 0xE5C078, group: 'web',    label: 'Bright galaxy',        pickable: true,  size: 3.0, min: 0.9,  max: 4.6, max3: 3.2, op: 0.85, op3: 0.15 },
  web_lrg:  { color: 0xD9785A, group: 'web',    label: 'Luminous red galaxy',  pickable: true,  size: 3.0, min: 0.9,  max: 4.6, max3: 3.2, op: 0.82, op3: 0.15 },
  web_elg:  { color: 0x6CA8CE, group: 'web',    label: 'Emission-line galaxy', pickable: true,  size: 2.6, min: 0.85, max: 4.2, max3: 3.0, op: 0.78, op3: 0.13 },
  qso_desi: { color: 0xA78BDB, group: 'qso',    label: 'Quasar',               pickable: true,  size: 3.2, min: 0.9,  max: 4.6, max3: 3.2, op: 0.85, op3: 0.22 },
  qso_sky:  { color: 0xA78BDB, group: 'qso',    label: 'Quasar',               pickable: false, size: 2.6, min: 0.85, max: 3.8, max3: 2.6, op: 0.55, op3: 0.13 }
};

// 3D brightness gain. The same opacity cannot serve a view of two million points
// stacked eight gigaparsecs deep and a view of two hundred points inside a single
// cluster, so the gain rides the camera's stand-off distance: fly in and the
// handful of galaxies around you brighten to legibility, pull out and they fall
// back so the cosmic web reads as density rather than glare.
export const GAIN3_REF = 420;          // Mpc — stand-off at which gain is 1
export const GAIN3_MAX = 5.0;
export const GAIN3_POW = 0.62;

export const GROUPS = [
  { id: 'stars',  name: 'Stars' },
  { id: 'nearby', name: 'Nearby' },
  { id: 'web',    name: 'Cosmic web' },
  { id: 'qso',    name: 'Quasars' }
];

// DESI layers carry TARGETID → they get spectra (§6.5).
export const HAS_SPECTRUM = new Set(['web_bgs', 'web_lrg', 'web_elg', 'qso_desi']);

// §6.5 rest-frame vacuum wavelengths (Å)
export const LINES_GAL_EM = [
  ['[O II]', 3728.5], ['Hβ', 4862.7], ['[O III]', 5008.2], ['Hα', 6564.6], ['[S II]', 6725]
];
export const LINES_GAL_ABS = [
  ['Ca K', 3934.8], ['Ca H', 3969.6], ['G', 4305.6], ['Mg b', 5176.7], ['Na D', 5893]
];
export const LINES_QSO = [
  ['Lyα', 1215.67], ['Si IV', 1399.8], ['C IV', 1549.5], ['C III]', 1908.7], ['Mg II', 2799.1]
];

export const SPARCL = 'https://astrosparcl.datalab.noirlab.edu/api';
export const CUTOUT = 'https://www.legacysurvey.org/viewer/jpeg-cutout';
export const HIPS2FITS = 'https://alasky.cds.unistra.fr/hips-image-services/hips2fits';
export const VIEWER = 'https://www.legacysurvey.org/viewer';

export const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const params = new URLSearchParams(location.search);
export const DATA_ROOT = (params.get('data') || 'data').replace(/\/+$/, '');
export const SHOW_GRATICULE = params.get('grid') === '1';
