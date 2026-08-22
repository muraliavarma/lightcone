"""Cosmology lookup tables + manifest.json assembly + tours.json. SPEC.md §4, §7."""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np

from common import COSMO, H0, OM0, DATA_DIR

N_TABLE_ROWS = 200

# tours.json content, verbatim from SPEC.md §7
TOURS = {
    "stops": [
        {
            "id": "home", "mode": "2d", "ra": 194.9, "dec": 28.0, "fov": 4,
            "title": "You are here",
            "text": "Every point of light in this app is a real measurement. This is the actual sky, photographed by a 4-meter telescope in Chile. Let's add the dimension your eyes can't see.",
        },
        {
            "id": "coma", "mode": "3d", "ra": 194.9, "dec": 28.0, "z": 0.023,
            "title": "The Coma Cluster",
            "text": "A thousand galaxies falling around each other, 340 million light-years away. The long smear toward you isn't real — it's their orbital speed contaminating the distance measurement. In 1933, this exact effect led Fritz Zwicky to suspect dark matter.",
        },
        {
            "id": "wall", "mode": "3d", "ra": 202.0, "dec": -1.0, "z": 0.073,
            "title": "The Sloan Great Wall",
            "text": "A sheet of galaxies 1.4 billion light-years long — one of the largest known structures. Gravity has spent 13 billion years gathering galaxies into these filaments and walls.",
        },
        {
            "id": "void", "mode": "3d", "ra": 222.0, "dec": 46.0, "z": 0.05,
            "title": "The Boötes Void",
            "text": "Almost nothing, for 330 million light-years. If the Milky Way sat at its center, we wouldn't have known other galaxies existed until the 1960s.",
        },
        {
            "id": "deep", "mode": "3d", "ra": 150.3, "dec": 2.2, "z": 2.5,
            "title": "Light older than the Sun",
            "text": "These dots are quasars — galaxies whose central black holes outshine everything around them. Their light left more than 11 billion years ago. The Sun would not form for another 6 billion.",
        },
    ]
}


def cosmology_tables():
    z_grid = np.linspace(0.0, 6.0, N_TABLE_ROWS)
    d_c = COSMO.comoving_distance(z_grid).value  # Mpc
    t_lb = COSMO.lookback_time(z_grid).value  # Gyr
    z_to_dc = [[float(z), float(d)] for z, d in zip(z_grid, d_c)]
    z_to_tlb = [[float(z), float(t)] for z, t in zip(z_grid, t_lb)]
    return z_to_dc, z_to_tlb


def write_tours_json():
    path = DATA_DIR / "tours.json"
    with open(path, "w") as f:
        json.dump(TOURS, f, indent=2, ensure_ascii=False)
    return path


def write_manifest(layers: list[dict]):
    z_to_dc, z_to_tlb = cosmology_tables()
    full_count = sum(f["count"] for layer in layers for f in layer["files"])
    lite_count = sum(f.get("lite", f)["count"] for layer in layers for f in layer["files"])
    manifest = {
        "version": 2,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "counts": {"full": full_count, "lite": lite_count},
        "cosmology": {"H0": H0, "Om": OM0, "note": "flat LCDM, Planck 2018"},
        "z_to_dc": z_to_dc,
        "z_to_tlb": z_to_tlb,
        "layers": [
            {"name": layer["name"], "files": layer["files"]}
            for layer in layers
        ],
    }
    path = DATA_DIR / "manifest.json"
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)
    return path, manifest
