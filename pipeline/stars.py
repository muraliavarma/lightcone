"""ATHYG m10 -> `stars` layer. SPEC.md §5.3.
Columns include x0,y0,z0 (equatorial cartesian, parsecs) and mag. Keep rows with dist>0.
"""
from __future__ import annotations

import csv
import gzip

import numpy as np

from common import DATA_DIR, download, write_xyz_scalar_shell, lod_idx

LITE_N = 100_000

ATHYG_URL = "https://raw.githubusercontent.com/astronexus/ATHYG-Database/main/data/subsets/athyg_32_reduced_m10.csv.gz"


def build_layer() -> dict:
    print("[stars] building 'stars'")
    path = download(ATHYG_URL, "athyg_32_reduced_m10.csv.gz", min_bytes=1_000_000)

    xs, ys, zs, mags = [], [], [], []
    n_in = 0
    with gzip.open(path, "rt", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            n_in += 1
            try:
                dist = float(row["dist"])
            except (ValueError, TypeError, KeyError):
                continue
            if not (dist > 0):
                continue
            try:
                x0 = float(row["x0"]); y0 = float(row["y0"]); z0 = float(row["z0"])
                mag = float(row["mag"])
            except (ValueError, TypeError, KeyError):
                continue
            xs.append(x0); ys.append(y0); zs.append(z0); mags.append(mag)

    xyz = np.array([xs, ys, zs], dtype=np.float64).T
    mag = np.array(mags, dtype=np.float64)
    dist = np.linalg.norm(xyz, axis=1)
    order = np.argsort(dist)
    xyz, mag, dist = xyz[order], mag[order], dist[order]
    n_out = len(mag)

    fname = "stars_shell00.bin"
    fpath = DATA_DIR / fname
    nbytes = write_xyz_scalar_shell(fpath, xyz, mag)
    li = lod_idx(n_out, min(LITE_N, n_out))
    lite_name = "stars_lite_shell00.bin"
    lite_bytes = write_xyz_scalar_shell(DATA_DIR / lite_name, xyz[li], mag[li])
    print(f"  rows_in={n_in:,} rows_out={n_out:,} bytes={nbytes + lite_bytes:,}")

    return {
        "name": "stars",
        "files": [{
            "path": fname, "count": int(n_out), "arrays": ["xyz", "mag"],
            "dmin": float(dist[0]), "dmax": float(dist[-1]),
            "lite": {"path": lite_name, "count": int(len(li))},
        }],
        "_rows_in": n_in,
        "_rows_out": n_out,
        "_bytes_out": nbytes + lite_bytes,
    }
