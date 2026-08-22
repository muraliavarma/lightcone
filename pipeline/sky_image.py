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
LOW_SIZE = (4096, 2048)
HOME_RA, HOME_DEC, HOME_FOV, HOME_PX = 194.9, 28.0, 7.0, 1536


def _url(host: str, w: int, h: int) -> str:
    return (
        f"https://{host}/hips-image-services/hips2fits"
        f"?hips=CDS%2FP%2FDSS2%2Fcolor&ra=0&dec=0&fov=360"
        f"&width={w}&height={h}&projection=CAR&format=jpg"
    )


def _try_fetch(url: str, dest, timeout: int = 180, min_bytes: int = 100_000) -> bool:
    try:
        cmd = ["curl", "-fsS", "-L", "--connect-timeout", "20", "--max-time", str(timeout), "-o", str(dest), url]
        subprocess.run(cmd, check=True, timeout=timeout + 20)
        return dest.exists() and dest.stat().st_size > min_bytes
    except Exception as e:  # noqa: BLE001
        print(f"    fetch failed: {e}")
        return False


def _ensure_car(dest, sizes, min_bytes):
    if dest.exists() and dest.stat().st_size > min_bytes:
        print(f"  [cache] {dest.name} ({dest.stat().st_size/1e6:.1f} MB)")
        return
    for w, h in sizes:
        for host in (PRIMARY_HOST, MIRROR_HOST):
            print(f"  trying {dest.name}: {host} at {w}x{h} ...")
            if _try_fetch(_url(host, w, h), dest, min_bytes=min_bytes):
                print(f"  ok: {w}x{h} from {host} ({dest.stat().st_size/1e6:.1f} MB)")
                return
    raise RuntimeError(f"failed to fetch {dest.name}")


def _home_url() -> str:
    pixscale = HOME_FOV * 3600 / HOME_PX
    return (
        "https://www.legacysurvey.org/viewer/jpeg-cutout"
        f"?ra={HOME_RA}&dec={HOME_DEC}&layer=ls-dr11"
        f"&pixscale={pixscale:.4f}&size={HOME_PX}"
    )


def _ensure_home(dest):
    if dest.exists() and dest.stat().st_size > 50_000:
        print(f"  [cache] {dest.name} ({dest.stat().st_size/1e6:.1f} MB)")
        return
    print("  fetching instant-start Coma DR11 field ...")
    # The courtesy API occasionally answers 429; curl retries transient errors.
    cmd = [
        "curl", "-fsS", "-L", "--retry", "5", "--retry-all-errors",
        "--retry-delay", "4", "--connect-timeout", "20", "--max-time", "180",
        "-o", str(dest), _home_url(),
    ]
    subprocess.run(cmd, check=True, timeout=220)
    if not dest.exists() or dest.stat().st_size < 50_000:
        raise RuntimeError("failed to fetch home_coma_dr11.jpg")


def build() -> dict:
    print("[sky_image] building sky plates")
    full = DATA_DIR / "sky_base.jpg"
    low = DATA_DIR / "sky_base_low.jpg"
    home = DATA_DIR / "home_coma_dr11.jpg"
    _ensure_car(full, SIZES, 500_000)
    _ensure_car(low, [LOW_SIZE], 100_000)
    _ensure_home(home)
    return {
        "path": full.name, "bytes": full.stat().st_size,
        "low_path": low.name, "low_bytes": low.stat().st_size,
        "home_path": home.name, "home_bytes": home.stat().st_size,
    }
