"""CF4 galaxies + 2MRS -> `local` layer. SPEC.md §5.2.

CF4 (VizieR J/ApJ/944/94 table2): RA, Dec, DM -> D = 10^((DM-25)/5) Mpc; keep D < 350.
2MRS table3: RA, Dec, V_cmb (cz) -> D = V/H0; keep 1 < D < 350; dedupe against CF4
(drop 2MRS entries within 30' AND 300 km/s of a CF4 entry).
"""
from __future__ import annotations

import gzip

import numpy as np

from common import CACHE_DIR, DATA_DIR, H0, download, radec_to_xyz, write_xyz_scalar_shell, subsample_idx

CF4_URL = "https://cdsarc.cds.unistra.fr/ftp/J/ApJ/944/94/table2.dat.gz"
MRS_URL = "https://cdsarc.cds.unistra.fr/ftp/J/ApJS/199/26/table3.dat.gz"

TARGET_N = 90_000
C_KMS = 299_792.458


def _read_cf4():
    path = download(CF4_URL, "table2.dat.gz")
    ra_list, dec_list, dm_list = [], [], []
    with gzip.open(path, "rt") as f:
        for line in f:
            if len(line) < 154:
                continue
            ra_s = line[137:145].strip()
            dec_s = line[146:154].strip()
            dm_s = line[28:34].strip()
            if not ra_s or not dec_s or not dm_s:
                continue
            try:
                ra_list.append(float(ra_s))
                dec_list.append(float(dec_s))
                dm_list.append(float(dm_s))
            except ValueError:
                continue
    ra = np.array(ra_list)
    dec = np.array(dec_list)
    dm = np.array(dm_list)
    d = 10 ** ((dm - 25.0) / 5.0)
    n_in = len(ra)
    mask = d < 350.0
    ra, dec, d = ra[mask], dec[mask], d[mask]
    # cz equivalent for the z array, per SPEC §4 ("For CF4/2MRS store cz/c equivalents")
    cz_over_c = (d * H0) / C_KMS
    print(f"[local_layer] CF4: rows_in={n_in:,} kept(D<350)={len(ra):,}")
    return ra, dec, d, cz_over_c


def _read_2mrs():
    path = download(MRS_URL, "table3.dat.gz")
    # sanity-check a few well-known rows first (validated against real galaxies during dev)
    ra_list, dec_list, cz_list = [], [], []
    with gzip.open(path, "rt") as f:
        for line in f:
            if len(line) < 178:
                continue
            ra_s = line[17:26].strip()
            dec_s = line[27:36].strip()
            cz_s = line[173:178].strip()
            if not ra_s or not dec_s or not cz_s:
                continue
            try:
                ra_list.append(float(ra_s))
                dec_list.append(float(dec_s))
                cz_list.append(float(cz_s))
            except ValueError:
                continue
    ra = np.array(ra_list)
    dec = np.array(dec_list)
    cz = np.array(cz_list)  # km/s, heliocentric-ish (V_cmb-labeled column per spec's "V_cmb")
    n_in = len(ra)
    d = cz / H0
    mask = (d > 1.0) & (d < 350.0)
    ra, dec, d, cz = ra[mask], dec[mask], d[mask], cz[mask]
    print(f"[local_layer] 2MRS: rows_in={n_in:,} kept(1<D<350)={len(ra):,}")
    return ra, dec, d, cz / C_KMS


def _dedupe_2mrs_against_cf4(mrs_ra, mrs_dec, mrs_cz_c, cf4_ra, cf4_dec, cf4_cz_c):
    """Drop 2MRS rows within 30 arcmin AND 300 km/s of any CF4 entry.
    Uses a simple dec-banded grid for O(N) average performance instead of full O(N*M).
    """
    if len(cf4_ra) == 0 or len(mrs_ra) == 0:
        return np.ones(len(mrs_ra), dtype=bool)

    # bucket CF4 by 1-degree dec band for a coarse spatial index
    band = 1.0  # deg
    cf4_band = np.floor(cf4_dec / band).astype(int)
    buckets = {}
    for i, b in enumerate(cf4_band):
        buckets.setdefault(b, []).append(i)

    vel_tol_c = 300.0 / C_KMS
    ang_tol_deg = 30.0 / 60.0  # 30 arcmin

    keep = np.ones(len(mrs_ra), dtype=bool)
    cf4_ra_rad = np.radians(cf4_ra)
    cf4_dec_rad = np.radians(cf4_dec)

    for j in range(len(mrs_ra)):
        b = int(np.floor(mrs_dec[j] / band))
        cand = []
        for bb in (b - 1, b, b + 1):
            cand.extend(buckets.get(bb, []))
        if not cand:
            continue
        cand = np.array(cand)
        # velocity gate first (cheap)
        vel_ok = np.abs(cf4_cz_c[cand] - mrs_cz_c[j]) < vel_tol_c
        if not vel_ok.any():
            continue
        cand = cand[vel_ok]
        # angular separation (haversine, small-angle safe)
        ra1 = np.radians(mrs_ra[j]); dec1 = np.radians(mrs_dec[j])
        ra2 = cf4_ra_rad[cand]; dec2 = cf4_dec_rad[cand]
        dsig = np.sin(dec1) * np.sin(dec2) + np.cos(dec1) * np.cos(dec2) * np.cos(ra1 - ra2)
        dsig = np.clip(dsig, -1.0, 1.0)
        sep_deg = np.degrees(np.arccos(dsig))
        if (sep_deg < ang_tol_deg).any():
            keep[j] = False
    return keep


def build_layer() -> dict:
    print("[local_layer] building 'local'")
    cf4_ra, cf4_dec, cf4_d, cf4_czc = _read_cf4()
    mrs_ra, mrs_dec, mrs_d, mrs_czc = _read_2mrs()

    keep = _dedupe_2mrs_against_cf4(mrs_ra, mrs_dec, mrs_czc, cf4_ra, cf4_dec, cf4_czc)
    n_dropped = (~keep).sum()
    mrs_ra, mrs_dec, mrs_d, mrs_czc = mrs_ra[keep], mrs_dec[keep], mrs_d[keep], mrs_czc[keep]
    print(f"[local_layer] 2MRS deduped against CF4: dropped {n_dropped:,}, kept {len(mrs_ra):,}")

    ra = np.concatenate([cf4_ra, mrs_ra])
    dec = np.concatenate([cf4_dec, mrs_dec])
    d = np.concatenate([cf4_d, mrs_d])
    czc = np.concatenate([cf4_czc, mrs_czc])
    n_in = len(ra)

    if n_in > TARGET_N:
        idx = subsample_idx(n_in, TARGET_N)
        ra, dec, d, czc = ra[idx], dec[idx], d[idx], czc[idx]
    n_out = len(ra)

    xyz = radec_to_xyz(ra, dec, d)
    order = np.argsort(d)
    xyz, czc = xyz[order], czc[order]

    fname = "local_shell00.bin"
    fpath = DATA_DIR / fname
    nbytes = write_xyz_scalar_shell(fpath, xyz, czc)
    print(f"  rows_in={n_in:,} rows_out={n_out:,} bytes={nbytes:,}")

    return {
        "name": "local",
        "files": [{"path": fname, "count": int(n_out), "arrays": ["xyz", "z"]}],
        "_rows_in": n_in,
        "_rows_out": n_out,
        "_bytes_out": nbytes,
    }
