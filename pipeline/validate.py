#!/usr/bin/env python3
"""Validate Lightcone's generated scientific data contract.

This catches the failures that are visually plausible but scientifically wrong:
truncated struct-of-arrays files, stale layers, broken TARGETID precision, an LOD
that changes layout, and accidental conflation of direct and redshift distances.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from common import DATA_DIR

# Kept local to avoid making the frontend/pipeline constants depend on each other.
C_KMS = 299_792.458
H0 = 67.4
REQUIRED = {
    "stars", "local_cf4", "local_2mrs", "web_bgs", "web_lrg",
    "web_elg", "qso_desi", "qso_sky",
}


def _read(path: Path, count: int, has_tid: bool):
    expected = count * (24 if has_tid else 16)
    assert path.is_file(), f"missing {path}"
    assert path.stat().st_size == expected, f"{path}: {path.stat().st_size} != {expected}"
    raw = np.memmap(path, dtype="u1", mode="r")
    xyz = np.ndarray((count, 3), dtype="<f4", buffer=raw, offset=0)
    sec = np.ndarray((count,), dtype="<f4", buffer=raw, offset=count * 12)
    tid = np.ndarray((count,), dtype="<i8", buffer=raw, offset=count * 16) if has_tid else None
    return xyz, sec, tid


def validate(data_dir: Path = DATA_DIR) -> dict:
    manifest = json.loads((data_dir / "manifest.json").read_text())
    layers = {layer["name"]: layer for layer in manifest["layers"]}
    assert REQUIRED <= layers.keys(), f"missing layers: {sorted(REQUIRED - layers.keys())}"

    referenced: set[str] = set()
    full_count = lite_count = 0
    stats = {}

    for name, layer in layers.items():
        distances = []
        scalars = []
        for f in layer["files"]:
            has_tid = "targetid" in f.get("arrays", [])
            xyz, sec, tid = _read(data_dir / f["path"], int(f["count"]), has_tid)
            referenced.add(f["path"])
            full_count += int(f["count"])
            d = np.linalg.norm(xyz, axis=1)
            assert np.isfinite(d).all() and np.isfinite(sec).all(), f"{name}: non-finite values"
            assert (d > 0).all(), f"{name}: zero/negative radius"
            if tid is not None:
                assert (tid > 2**53).any(), f"{name}: TARGETID precision invariant failed"
            distances.append(d)
            scalars.append(np.asarray(sec))

            lite = f.get("lite")
            if lite:
                lxyz, lsec, ltid = _read(data_dir / lite["path"], int(lite["count"]), has_tid)
                referenced.add(lite["path"])
                lite_count += int(lite["count"])
                assert int(lite["count"]) <= int(f["count"]), f"{name}: LOD grew"
                assert np.isfinite(lxyz).all() and np.isfinite(lsec).all()
                if has_tid:
                    assert ltid is not None and (ltid > 2**53).any()
            else:
                lite_count += int(f["count"])

        d = np.concatenate(distances)
        sec = np.concatenate(scalars)
        stats[name] = {"count": len(d), "dmin": float(d.min()), "dmax": float(d.max())}

        if name == "local_2mrs":
            hubble_d = sec * C_KMS / H0
            assert np.max(np.abs(d - hubble_d)) < 0.01, "2MRS xyz is not its declared cz/H0 distance"
        elif name == "local_cf4":
            hubble_d = sec * C_KMS / H0
            # Direct indicators must not have silently regressed to cz/H0.
            assert np.median(np.abs(d - hubble_d)) > 1.0, "CF4 direct distances were replaced by redshift distances"

    assert full_count == manifest["counts"]["full"]
    assert lite_count == manifest["counts"]["lite"]
    assert stats["local_cf4"]["dmin"] < 0.1 and stats["local_cf4"]["dmax"] < 350
    assert 1 < stats["local_2mrs"]["dmin"] and stats["local_2mrs"]["dmax"] < 350
    assert stats["qso_sky"]["dmax"] > 5_000

    # The all-sky catalog supplements DESI; it must not double-render the same
    # quasar. Recheck the build-time 2″ + Δz criterion from the emitted files.
    def emitted(layer_name):
        xs, zs = [], []
        for f in layers[layer_name]["files"]:
            xyz, z, _ = _read(data_dir / f["path"], int(f["count"]), "targetid" in f.get("arrays", []))
            xs.append(np.asarray(xyz).copy()); zs.append(np.asarray(z).copy())
        return np.concatenate(xs), np.concatenate(zs)

    desi_xyz, desi_z = emitted("qso_desi")
    sky_xyz, sky_z = emitted("qso_sky")
    desi_u = desi_xyz / np.linalg.norm(desi_xyz, axis=1)[:, None]
    sky_u = sky_xyz / np.linalg.norm(sky_xyz, axis=1)[:, None]
    radius = 2 * np.sin(np.radians(2 / 3600) / 2)
    _, nearest = cKDTree(desi_u).query(sky_u, distance_upper_bound=radius, workers=-1)
    candidate = nearest < len(desi_z)
    duplicates = np.zeros(len(sky_z), dtype=bool)
    duplicates[candidate] = np.abs(sky_z[candidate] - desi_z[nearest[candidate]]) < 0.02
    assert not duplicates.any(), f"DESI/Milliquas duplicate points: {duplicates.sum()}"

    orphans = {p.name for p in data_dir.glob("*.bin")} - referenced
    assert not orphans, f"orphan generated binaries: {sorted(orphans)}"
    for image in ("sky_base.jpg", "sky_base_low.jpg", "home_coma_dr11.jpg"):
        p = data_dir / image
        assert p.is_file() and p.stat().st_size > 50_000, f"missing/short {image}"

    return {"full": full_count, "lite": lite_count, "layers": stats}


if __name__ == "__main__":
    result = validate()
    print(f"validated {result['full']:,} full / {result['lite']:,} lite points")
    for name, s in result["layers"].items():
        print(f"  {name:<12} {s['count']:>8,}  D={s['dmin']:.3f}..{s['dmax']:.1f}")
