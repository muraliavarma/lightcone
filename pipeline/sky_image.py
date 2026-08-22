"""Full-sky CAR image -> app/data/sky_base.jpg. SPEC.md §5.5.

hips2fits full-sky CAR 8192x4096 JPEG (CDS/P/DSS2/color); fall back to the
alaskybis mirror; if both fail at 8192, drop to 6144x3072.
"""
from __future__ import annotations

import subprocess

from common import DATA_DIR

PRIMARY_HOST = "alasky.cds.unistra.fr"
MIRROR_HOST = "alaskybis.cds.unistra.fr"

SIZES = [(8192, 4096), (6144, 3072)]


def _url(host: str, w: int, h: int) -> str:
    return (
        f"https://{host}/hips-image-services/hips2fits"
        f"?hips=CDS%2FP%2FDSS2%2Fcolor&ra=0&dec=0&fov=360"
        f"&width={w}&height={h}&projection=CAR&format=jpg"
    )


def _try_fetch(url: str, dest, timeout: int = 180) -> bool:
    try:
        cmd = ["curl", "-sS", "-L", "--connect-timeout", "20", "--max-time", str(timeout), "-o", str(dest), url]
        subprocess.run(cmd, check=True, timeout=timeout + 20)
        return dest.exists() and dest.stat().st_size > 500_000  # a real full-sky JPEG is MBs
    except Exception as e:  # noqa: BLE001
        print(f"    fetch failed: {e}")
        return False


def build() -> dict:
    print("[sky_image] building sky_base.jpg")
    dest = DATA_DIR / "sky_base.jpg"
    if dest.exists() and dest.stat().st_size > 500_000:
        print(f"  [cache] sky_base.jpg ({dest.stat().st_size/1e6:.1f} MB)")
        return {"path": "sky_base.jpg", "bytes": dest.stat().st_size}

    for w, h in SIZES:
        for host in (PRIMARY_HOST, MIRROR_HOST):
            url = _url(host, w, h)
            print(f"  trying {host} at {w}x{h} ...")
            if _try_fetch(url, dest):
                print(f"  ok: {w}x{h} from {host} ({dest.stat().st_size/1e6:.1f} MB)")
                return {"path": "sky_base.jpg", "bytes": dest.stat().st_size, "size_px": [w, h]}
    raise RuntimeError("failed to fetch sky_base.jpg from any host/size combination")
