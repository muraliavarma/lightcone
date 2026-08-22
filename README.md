# Lightcone

**Live: https://lightcone.murlax.com**

Mirror: https://lightcone.muraliavarma.workers.dev

Lightcone puts the photographed sky and its measured depth in one continuous
map. Start on a real Legacy Surveys DR11 image, zoom down to individual
survey pixels, then press **Depth · 3D** to unfold the same sightline into the
cosmic web.

The full view contains 2.8 million real measurements: 1.9M DESI DR1 galaxies
and quasars, 500k confirmed Milliquas quasars (de-duplicated against DESI),
328k Gaia-derived stars, and 78k nearby galaxies from Cosmicflows-4 and 2MRS.
Nothing is simulated.

- **Time lens** isolates objects whose light left during the same era. It is a
  redshift focus plane on the photograph and a radial cross-section in 3D.
- Click a galaxy or quasar to mark it on the main map and inspect its real
  survey image and measured distance. DESI targets also load their actual
  spectrum from NOIRLab SPARCL.
- **Zoom to this object in the photograph** closes the loop from a 3D point
  back to a 4.8′ telescope field and highlights neighbors at the same cosmic
  time.
- **Tour** visits Coma, the Sloan Great Wall, the Boötes Void, and deep quasars.
- Phones automatically use an 848k-point LOD, a smaller sky plate, bounded
  texture caching, and lower GPU resolution. Add `?quality=full` to override.

No accounts, analytics, cookies, backend, or generated stand-ins.

## Run it

**1. Build the data** (one-time ~1.2 GB download; subsequent builds use cache):

```sh
python3 -m venv .venv
.venv/bin/pip install numpy astropy scipy requests
.venv/bin/python pipeline/build.py --all
```

Build one source with `--layer web_bgs`, `local`, `stars`, `qso_sky`, or
`sky_image`. Generated files go to `app/data/`; raw downloads stay in
`pipeline/cache/`. Both are gitignored.

**2. Serve the static app:**

```sh
python3 -m http.server 8143 -d app
```

Open http://localhost:8143. There is no frontend build step.

## Data and credits

DESI DR1 (CC BY 4.0; DESI Collaboration); DESI Legacy Imaging Surveys DR11
(Dey et al. 2019; CTIO/Blanco DECam, KPNO Mayall + Bok, NEOWISE); ATHYG v3.2
(CC BY-SA 4.0, astronexus; Gaia DR3-derived); Cosmicflows-4 (Tully et al.
2023; redshift-independent distances); 2MRS (Huchra et al. 2012;
CMB-corrected redshift distances); Milliquas v8 (Flesch 2023). Spectra are
served by NOIRLab SPARCL; imagery by Legacy Surveys and CDS hips2fits.
