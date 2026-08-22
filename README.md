# Lightcone

**Live: https://lightcone.muraliavarma.workers.dev**

Look at the real sky, toggle it into 3D, and fly through ~2.8M real DESI
redshifts — every dot is a measured galaxy, quasar, or star. Click any dot
to see its actual photograph and its actual spectrum. Press **tour** for a
five-stop guided flight, **Depth · 3D** to unfold the sky you're looking at.

No accounts, tracking, or simulated data — everything shown is a real
measurement, or the app says so.

## Run it

**1. Build the data** (one-time, ~1.2 GB download, ~1 min to process):

```
python3 -m venv .venv
.venv/bin/pip install numpy astropy scipy requests
.venv/bin/python pipeline/build.py --all
```

Outputs go to `app/data/` (gitignored). Re-running skips cached downloads
in `pipeline/cache/`. Build a single layer with `--layer <name>` (e.g.
`web_bgs`, `local`, `stars`, `qso_sky`, `sky_image`).

**2. Serve the app:**

```
python3 -m http.server 8143 -d app
```

Open `http://localhost:8143`.

## Layout

- `pipeline/` — Python data pipeline (this repo's own code + `app/data/` output)
- `app/` — static frontend (vanilla JS + three.js, no build step)

## Credits

DESI DR1 (CC BY 4.0; DESI Collaboration); DESI Legacy Imaging Surveys DR11
(Dey et al. 2019; CTIO/Blanco DECam, KPNO Mayall + Bok, NEOWISE); ATHYG v3.2
(CC BY-SA 4.0, astronexus); Cosmicflows-4 (Tully et al. 2023); 2MRS (Huchra
et al. 2012); Milliquas v8 (Flesch 2023); spectra served by NOIRLab SPARCL;
imagery cutouts by legacysurvey.org and CDS hips2fits.
