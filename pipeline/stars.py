"""ATHYG m10 -> `stars` layer. SPEC.md §5.3.
Columns include x0,y0,z0 (equatorial cartesian, parsecs) and mag. Keep rows with dist>0.
"""
from __future__ import annotations

import csv
import gzip

import numpy as np

from common import DATA_DIR, download, write_xyz_scalar_shell

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
    n_out = len(mag)

    fname = "stars_shell00.bin"
    fpath = DATA_DIR / fname
    nbytes = write_xyz_scalar_shell(fpath, xyz, mag)
    print(f"  rows_in={n_in:,} rows_out={n_out:,} bytes={nbytes:,}")

    return {
        "name": "stars",
        "files": [{"path": fname, "count": int(n_out), "arrays": ["xyz", "mag"]}],
        "_rows_in": n_in,
        "_rows_out": n_out,
        "_bytes_out": nbytes,
    }
