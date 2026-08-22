"""DESI LSS clustering catalogs -> web_bgs, web_lrg, web_elg, qso_desi layers.
SPEC.md §5.1.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from astropy.io import fits

from common import (
    CACHE_DIR, DATA_DIR, COSMO, BYTES_PER_ROW_DESI,
    download, radec_to_xyz, write_desi_shell, n_shells_for, subsample_idx,
)

BASE_URL = "https://data.desi.lbl.gov/public/dr1/survey/catalogs/dr1/LSS/iron/LSScats/v1.5"
CAPS = ("NGC", "SGC")

# tracer name in the DESI file naming -> (layer name, target row count)
TRACERS = {
    "BGS_BRIGHT": ("web_bgs", 500_000),
    "LRG": ("web_lrg", 400_000),
    "ELG_LOPnotqso": ("web_elg", 600_000),
    "QSO": ("qso_desi", 400_000),
}


def _download_tracer(tracer: str) -> list[Path]:
    paths = []
    for cap in CAPS:
        fname = f"{tracer}_{cap}_clustering.dat.fits"
        url = f"{BASE_URL}/{fname}"
        paths.append(download(url, fname, min_bytes=1_000_000))
    return paths


def _read_columns(path: Path):
    with fits.open(path, memmap=True) as hdul:
        data = hdul[1].data
        targetid = np.asarray(data["TARGETID"], dtype=np.int64)
        ra = np.asarray(data["RA"], dtype=np.float64)
        dec = np.asarray(data["DEC"], dtype=np.float64)
        z = np.asarray(data["Z"], dtype=np.float64)
    return targetid, ra, dec, z


def build_layer(tracer: str) -> dict:
    layer_name, target_n = TRACERS[tracer]
    print(f"[desi_lss] {tracer} -> layer '{layer_name}'")
    paths = _download_tracer(tracer)

    tid_parts, ra_parts, dec_parts, z_parts = [], [], [], []
    n_in = 0
    for p in paths:
        tid, ra, dec, z = _read_columns(p)
        n_in += len(z)
        tid_parts.append(tid)
        ra_parts.append(ra)
        dec_parts.append(dec)
        z_parts.append(z)

    targetid = np.concatenate(tid_parts)
    ra = np.concatenate(ra_parts)
    dec = np.concatenate(dec_parts)
    z = np.concatenate(z_parts)

    # filter: finite Z, 0.001 < Z < 4.5
    mask = np.isfinite(z) & (z > 0.001) & (z < 4.5)
    targetid, ra, dec, z = targetid[mask], ra[mask], dec[mask], z[mask]
    n_valid = len(z)

    # uniform random subsample, fixed seed 42
    idx = subsample_idx(n_valid, target_n)
    targetid, ra, dec, z = targetid[idx], ra[idx], dec[idx], z[idx]
    n_out = len(z)

    d_c = COSMO.comoving_distance(z).value  # Mpc
    xyz = radec_to_xyz(ra, dec, d_c)

    # shell-split ordered by distance (near shells first)
    order = np.argsort(d_c)
    xyz, z, targetid = xyz[order], z[order], targetid[order]

    n_shells = n_shells_for(n_out, BYTES_PER_ROW_DESI)
    shell_bounds = np.array_split(np.arange(n_out), n_shells)

    files = []
    total_bytes = 0
    for i, sel in enumerate(shell_bounds):
        if len(sel) == 0:
            continue
        fname = f"{layer_name}_shell{i:02d}.bin"
        fpath = DATA_DIR / fname
        nbytes = write_desi_shell(fpath, xyz[sel], z[sel], targetid[sel])
        total_bytes += nbytes
        files.append({"path": fname, "count": int(len(sel)), "arrays": ["xyz", "z", "targetid"]})

    print(f"  rows_in={n_in:,} valid={n_valid:,} rows_out={n_out:,} shells={len(files)} bytes={total_bytes:,}")
    return {
        "name": layer_name,
        "files": files,
        "_rows_in": n_in,
        "_rows_out": n_out,
        "_bytes_out": total_bytes,
    }


def build_all() -> list[dict]:
    return [build_layer(t) for t in TRACERS]
