#!/usr/bin/env python3
"""Lightcone data pipeline entrypoint. SPEC.md §5.

Usage:
    python pipeline/build.py --all
    python pipeline/build.py --layer web_bgs
    python pipeline/build.py --layer local
    python pipeline/build.py --layer stars
    python pipeline/build.py --layer qso_sky
    python pipeline/build.py --layer sky_image
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import desi_lss
import local_layer
import stars
import quasar_sky
import sky_image
import manifest as manifest_mod
import validate as validate_mod
from common import DATA_DIR, print_summary

DESI_LAYER_TO_TRACER = {v[0]: k for k, v in desi_lss.TRACERS.items()}

ALL_LAYERS = ["web_bgs", "web_lrg", "web_elg", "qso_desi", "local", "stars", "qso_sky"]


def build_one(name: str) -> dict | list[dict] | None:
    if name in DESI_LAYER_TO_TRACER:
        return desi_lss.build_layer(DESI_LAYER_TO_TRACER[name])
    if name == "local":
        return local_layer.build_layers()
    if name == "stars":
        return stars.build_layer()
    if name == "qso_sky":
        return quasar_sky.build_layer()
    if name == "sky_image":
        sky_image.build()
        return None
    raise ValueError(f"unknown layer: {name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="build every layer + sky image + manifest + tours")
    ap.add_argument("--layer", type=str, default=None, help="build a single layer")
    args = ap.parse_args()

    if not args.all and not args.layer:
        ap.error("pass --all or --layer <name>")

    t0 = time.time()
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if args.layer:
        build_one(args.layer)
        print(f"\ndone in {time.time()-t0:.1f}s")
        return

    # --all — generated filenames evolve with the data contract; do not deploy
    # stale binary layers left by an older build.
    for old in DATA_DIR.glob("*.bin"):
        old.unlink()

    layer_results = []
    for name in ALL_LAYERS:
        res = build_one(name)
        if isinstance(res, list):
            layer_results.extend(res)
        elif res is not None:
            layer_results.append(res)

    sky_image.build()
    manifest_mod.write_tours_json()
    manifest_path, manifest = manifest_mod.write_manifest(layer_results)

    summary_rows = [
        (r["name"], r["_rows_in"], r["_rows_out"], r["_bytes_out"] / 1e6)
        for r in layer_results
    ]
    print_summary(summary_rows)

    total_bytes = sum(f.stat().st_size for f in DATA_DIR.iterdir() if f.is_file())
    checked = validate_mod.validate()
    print(f"\nvalidated: {checked['full']:,} full / {checked['lite']:,} lite points")
    print(f"app/data/ total size: {total_bytes/1e6:.2f} MB")
    print(f"manifest: {manifest_path}")
    print(f"done in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
