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
from scipy.spatial import cKDTree

from common import CACHE_DIR, DATA_DIR, COSMO, download, radec_to_xyz, write_xyz_scalar_shell, subsample_idx, lod_idx

ZIP_URL = "https://quasars.org/milliquas.fits.zip"
TARGET_N = 500_000
LITE_N = 100_000
MATCH_ARCSEC = 2.0


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


def _dedupe_desi(ra, dec, redshift):
    """Drop Milliquas entries already represented by the DESI QSO layer."""
    refs = sorted(DATA_DIR.glob("qso_desi_shell*.bin"))
    if not refs:
        print("  [warn] qso_desi layer absent; Milliquas/DESI dedupe skipped")
        return np.ones(len(ra), dtype=bool)

    desi_units, desi_z = [], []
    for path in refs:
        n = path.stat().st_size // 24
        raw = np.memmap(path, dtype="u1", mode="r")
        xyz = np.ndarray((n, 3), dtype="<f4", buffer=raw, offset=0)
        z = np.ndarray((n,), dtype="<f4", buffer=raw, offset=n * 12)
        norm = np.linalg.norm(xyz, axis=1)
        desi_units.append(np.asarray(xyz / norm[:, None], dtype=np.float32))
        desi_z.append(np.asarray(z).copy())
    ref_u = np.concatenate(desi_units)
    ref_z = np.concatenate(desi_z)

    r, d = np.radians(ra), np.radians(dec)
    cd = np.cos(d)
    query_u = np.column_stack((cd * np.cos(r), cd * np.sin(r), np.sin(d))).astype(np.float32)
    radius = 2 * np.sin(np.radians(MATCH_ARCSEC / 3600) / 2)
    dist, nearest = cKDTree(ref_u).query(query_u, distance_upper_bound=radius, workers=-1)
    matched = nearest < len(ref_z)
    same = np.zeros(len(ra), dtype=bool)
    # Redshift guard prevents a rare close angular pair from being merged.
    same[matched] = np.abs(redshift[matched] - ref_z[nearest[matched]]) < 0.02
    print(f"  deduped against DESI QSO: dropped {same.sum():,} matches within {MATCH_ARCSEC:.0f}″")
    return ~same


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
    n_valid_before_dedupe = len(ra)
    keep = _dedupe_desi(ra, dec, z)
    ra, dec, z = ra[keep], dec[keep], z[keep]
    n_valid = len(ra)

    idx = subsample_idx(n_valid, TARGET_N)
    ra, dec, z = ra[idx], dec[idx], z[idx]
    n_out = len(ra)

    d_c = COSMO.comoving_distance(z).value
    xyz = radec_to_xyz(ra, dec, d_c)
    order = np.argsort(d_c)
    xyz, z, d_c = xyz[order], z[order], d_c[order]

    fname = "qso_sky_shell00.bin"
    fpath = DATA_DIR / fname
    nbytes = write_xyz_scalar_shell(fpath, xyz, z)
    li = lod_idx(n_out, min(LITE_N, n_out))
    lite_name = "qso_sky_lite_shell00.bin"
    lite_bytes = write_xyz_scalar_shell(DATA_DIR / lite_name, xyz[li], z[li])
    print(f"  rows_in={n_in:,} confirmed={n_valid_before_dedupe:,} unique={n_valid:,} rows_out={n_out:,} bytes={nbytes + lite_bytes:,}")

    return {
        "name": "qso_sky",
        "files": [{
            "path": fname, "count": int(n_out), "arrays": ["xyz", "z"],
            "dmin": float(d_c[0]), "dmax": float(d_c[-1]),
            "lite": {"path": lite_name, "count": int(len(li))},
        }],
        "_rows_in": n_in,
        "_rows_out": n_out,
        "_bytes_out": nbytes + lite_bytes,
    }
