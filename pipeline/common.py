"""Shared utilities for the Lightcone data pipeline.

Handles: cached/resumable downloads, cosmology, coordinate conversion,
and the binary struct-of-arrays writer for the app/data/ contract (SPEC.md §4).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from astropy.cosmology import FlatLambdaCDM

# --- Paths -------------------------------------------------------------
PIPELINE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PIPELINE_DIR.parent
CACHE_DIR = PIPELINE_DIR / "cache"
DATA_DIR = REPO_ROOT / "app" / "data"

CACHE_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

# --- Constants -----------------------------------------------------------
SEED = 42
H0 = 67.4
OM0 = 0.315
COSMO = FlatLambdaCDM(H0=H0, Om0=OM0)

MAX_FILE_BYTES = 20 * 1024 * 1024  # hard cap per SPEC §4
MIN_CACHE_BYTES = 1024  # "verify size > 1 KB" per SPEC §5

BYTES_PER_ROW_DESI = 4 * 3 + 4 + 8   # xyz(f32) + z(f32) + targetid(i64)
BYTES_PER_ROW_16 = 4 * 3 + 4         # xyz(f32) + (z or mag)(f32)


def rng() -> np.random.Generator:
    return np.random.default_rng(SEED)


# --- Download --------------------------------------------------------------
def download(url: str, dest_name: str, retries: int = 3, min_bytes: int = MIN_CACHE_BYTES) -> Path:
    """Download `url` into pipeline/cache/dest_name with resume + retry.
    Skips download if a cached file already exists and passes the size check.
    """
    dest = CACHE_DIR / dest_name
    if dest.exists() and dest.stat().st_size > min_bytes:
        print(f"  [cache] {dest_name} ({dest.stat().st_size/1e6:.1f} MB)")
        return dest

    print(f"  [download] {url} -> {dest_name}")
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            cmd = [
                "curl", "-sS", "-L", "-C", "-",
                "--retry", "2", "--retry-delay", "3",
                "--connect-timeout", "20",
                "-o", str(dest), url,
            ]
            subprocess.run(cmd, check=True, timeout=1800)
            if dest.exists() and dest.stat().st_size > min_bytes:
                print(f"    ok ({dest.stat().st_size/1e6:.1f} MB)")
                return dest
            last_err = RuntimeError(f"downloaded file too small: {dest}")
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"    attempt {attempt}/{retries} failed: {e}", file=sys.stderr)
    raise RuntimeError(f"failed to download {url} after {retries} attempts: {last_err}")


# --- Coordinates -----------------------------------------------------------
def radec_to_xyz(ra_deg: np.ndarray, dec_deg: np.ndarray, d: np.ndarray) -> np.ndarray:
    """Equatorial cartesian, per SPEC §4: x=D cos(dec)cos(ra), y=D cos(dec)sin(ra), z=D sin(dec).
    Returns an (N,3) float64 array.
    """
    ra = np.radians(ra_deg)
    dec = np.radians(dec_deg)
    cd = np.cos(dec)
    x = d * cd * np.cos(ra)
    y = d * cd * np.sin(ra)
    z = d * np.sin(dec)
    return np.stack([x, y, z], axis=1)


# --- Binary writer -----------------------------------------------------------
def write_desi_shell(path: Path, xyz: np.ndarray, z: np.ndarray, targetid: np.ndarray) -> int:
    """[Float32 xyz x 3N][Float32 z x N][BigInt64 targetid x N]. Returns bytes written."""
    xyz32 = np.ascontiguousarray(xyz, dtype="<f4")
    z32 = np.ascontiguousarray(z, dtype="<f4")
    tid64 = np.ascontiguousarray(targetid, dtype="<i8")
    with open(path, "wb") as f:
        f.write(xyz32.tobytes(order="C"))
        f.write(z32.tobytes(order="C"))
        f.write(tid64.tobytes(order="C"))
    n = len(z)
    nbytes = n * BYTES_PER_ROW_DESI
    assert path.stat().st_size == nbytes, (path, path.stat().st_size, nbytes)
    assert nbytes <= MAX_FILE_BYTES, f"{path} exceeds 20MB: {nbytes}"
    return nbytes


def write_xyz_scalar_shell(path: Path, xyz: np.ndarray, scalar: np.ndarray) -> int:
    """[Float32 xyz x 3N][Float32 scalar x N] -- used for local/qso_sky (scalar=z) and stars (scalar=mag)."""
    xyz32 = np.ascontiguousarray(xyz, dtype="<f4")
    s32 = np.ascontiguousarray(scalar, dtype="<f4")
    with open(path, "wb") as f:
        f.write(xyz32.tobytes(order="C"))
        f.write(s32.tobytes(order="C"))
    n = len(scalar)
    nbytes = n * BYTES_PER_ROW_16
    assert path.stat().st_size == nbytes, (path, path.stat().st_size, nbytes)
    assert nbytes <= MAX_FILE_BYTES, f"{path} exceeds 20MB: {nbytes}"
    return nbytes


def n_shells_for(n_rows: int, bytes_per_row: int, target_bytes: int = 4 * 1024 * 1024,
                  min_shells: int = 1, max_shells: int = 12) -> int:
    total = n_rows * bytes_per_row
    n = -(-total // target_bytes)  # ceil
    return int(min(max(n, min_shells), max_shells))


def subsample_idx(n_total: int, n_target: int) -> np.ndarray:
    """Uniform random subsample indices, fixed seed 42, sorted for locality."""
    g = rng()
    if n_target >= n_total:
        idx = np.arange(n_total)
    else:
        idx = g.choice(n_total, size=n_target, replace=False)
    idx.sort()
    return idx


def print_summary(rows: list[tuple]) -> None:
    """rows: list of (layer, rows_in, rows_out, mb_out)"""
    print()
    print(f"{'layer':<12} {'rows in':>12} {'rows out':>12} {'MB out':>10}")
    print("-" * 50)
    total_mb = 0.0
    for name, n_in, n_out, mb in rows:
        print(f"{name:<12} {n_in:>12,} {n_out:>12,} {mb:>10.2f}")
        total_mb += mb
    print("-" * 50)
    print(f"{'TOTAL':<12} {'':>12} {'':>12} {total_mb:>10.2f}")
