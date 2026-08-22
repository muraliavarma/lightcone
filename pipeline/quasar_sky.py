"""Milliquas -> `qso_sky` layer. SPEC.md §5.4.

Keep rows whose TYPE marks a confirmed QSO/AGN with spectroscopic z (require
z present, z<5, TYPE containing 'Q' -- validated against the catalog: rows
from photometric-only candidate catalogs (e.g. CITE=='XDQSO') never carry a
'Q' in TYPE in this Milliquas v8 build, so this filter reliably selects
spectroscopically-confirmed type-1 QSOs; z is the catalog's z, which for
'Q'-typed rows is a spectroscopic redshift per the Milliquas README).
"""
from __future__ import annotations

import zipfile
from pathlib import Path

import numpy as np
from astropy.io import fits

from common import CACHE_DIR, DATA_DIR, COSMO, download, radec_to_xyz, write_xyz_scalar_shell, subsample_idx

ZIP_URL = "https://quasars.org/milliquas.fits.zip"
TARGET_N = 500_000


def _ensure_fits() -> Path:
    fits_path = CACHE_DIR / "milliquas.fits"
    if fits_path.exists() and fits_path.stat().st_size > 1_000_000:
        return fits_path
    zip_path = download(ZIP_URL, "milliquas.fits.zip", min_bytes=1_000_000)
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".fits")]
        assert names, f"no .fits member found in {zip_path}"
        zf.extract(names[0], path=CACHE_DIR)
        extracted = CACHE_DIR / names[0]
        if extracted != fits_path:
            extracted.rename(fits_path)
    return fits_path


def build_layer() -> dict:
    print("[quasar_sky] building 'qso_sky'")
    path = _ensure_fits()
    with fits.open(path, memmap=True) as hdul:
        data = hdul[1].data
        ra = np.asarray(data["RA"], dtype=np.float64)
        dec = np.asarray(data["DEC"], dtype=np.float64)
        z = np.asarray(data["Z"], dtype=np.float64)
        ttype = np.asarray(data["TYPE"])
    n_in = len(ra)

    has_q = np.char.find(ttype.astype(str), "Q") >= 0
    mask = has_q & np.isfinite(z) & (z > 0.0) & (z < 5.0)
    ra, dec, z = ra[mask], dec[mask], z[mask]
    n_valid = len(ra)

    idx = subsample_idx(n_valid, TARGET_N)
    ra, dec, z = ra[idx], dec[idx], z[idx]
    n_out = len(ra)

    d_c = COSMO.comoving_distance(z).value
    xyz = radec_to_xyz(ra, dec, d_c)
    order = np.argsort(d_c)
    xyz, z = xyz[order], z[order]

    fname = "qso_sky_shell00.bin"
    fpath = DATA_DIR / fname
    nbytes = write_xyz_scalar_shell(fpath, xyz, z)
    print(f"  rows_in={n_in:,} valid={n_valid:,} rows_out={n_out:,} bytes={nbytes:,}")

    return {
        "name": "qso_sky",
        "files": [{"path": fname, "count": int(n_out), "arrays": ["xyz", "z"]}],
        "_rows_in": n_in,
        "_rows_out": n_out,
        "_bytes_out": nbytes,
    }
