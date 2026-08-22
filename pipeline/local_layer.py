"""Nearby-universe layers: Cosmicflows-4 + 2MRS. SPEC.md §5.2.

These catalogs must stay distinct. Cosmicflows-4 positions use redshift-independent
indicator distances; 2MRS positions use a CMB-corrected redshift/H0 estimate. The
old combined layer called both "directly measured", which was scientifically false.
"""
from __future__ import annotations

import gzip

import numpy as np

from common import DATA_DIR, H0, download, radec_to_xyz, write_xyz_scalar_shell

CF4_URL = "https://cdsarc.cds.unistra.fr/ftp/J/ApJ/944/94/table2.dat.gz"
MRS_URL = "https://cdsarc.cds.unistra.fr/ftp/J/ApJS/199/26/table3.dat.gz"

C_KMS = 299_792.458
CMB_SPEED = 369.82
CMB_L_DEG = 264.021
CMB_B_DEG = 48.253


def _read_cf4():
    path = download(CF4_URL, "table2.dat.gz")
    ra_list, dec_list, dm_list, vcmb_list = [], [], [], []
    with gzip.open(path, "rt") as f:
        for line in f:
            if len(line) < 154:
                continue
            # VizieR J/ApJ/944/94 table2: byte positions are 1-indexed in ReadMe.
            vcmb_s = line[22:27].strip()
            dm_s = line[28:34].strip()
            ra_s = line[137:145].strip()
            dec_s = line[146:154].strip()
            if not ra_s or not dec_s or not dm_s or not vcmb_s:
                continue
            try:
                ra_list.append(float(ra_s))
                dec_list.append(float(dec_s))
                dm_list.append(float(dm_s))
                vcmb_list.append(float(vcmb_s))
            except ValueError:
                continue
    ra = np.array(ra_list)
    dec = np.array(dec_list)
    dm = np.array(dm_list)
    vcmb = np.array(vcmb_list)
    d = 10 ** ((dm - 25.0) / 5.0)
    n_in = len(ra)
    mask = np.isfinite(d) & (d > 0.01) & (d < 350.0)
    ra, dec, d, vcmb = ra[mask], dec[mask], d[mask], vcmb[mask]
    print(f"[local_layer] CF4: rows_in={n_in:,} kept(0<D<350)={len(ra):,}")
    return ra, dec, d, vcmb / C_KMS


def _read_2mrs():
    path = download(MRS_URL, "table3.dat.gz")
    ra_list, dec_list, glon_list, glat_list, cz_list = [], [], [], [], []
    with gzip.open(path, "rt") as f:
        for line in f:
            if len(line) < 178:
                continue
            ra_s, dec_s = line[17:26].strip(), line[27:36].strip()
            glon_s, glat_s = line[37:46].strip(), line[47:56].strip()
            cz_s = line[173:178].strip()
            if not all((ra_s, dec_s, glon_s, glat_s, cz_s)):
                continue
            try:
                ra_list.append(float(ra_s)); dec_list.append(float(dec_s))
                glon_list.append(float(glon_s)); glat_list.append(float(glat_s))
                cz_list.append(float(cz_s))
            except ValueError:
                continue
    ra, dec = np.array(ra_list), np.array(dec_list)
    glon, glat, cz_helio = np.array(glon_list), np.array(glat_list), np.array(cz_list)
    n_in = len(ra)
    # Transform the catalog's solar-system-frame cz to the CMB frame before
    # applying Hubble's law. This matters by several Mpc in the nearby universe.
    l, b = np.radians(glon), np.radians(glat)
    la, ba = np.radians(CMB_L_DEG), np.radians(CMB_B_DEG)
    projection = np.sin(b) * np.sin(ba) + np.cos(b) * np.cos(ba) * np.cos(l - la)
    vcmb = cz_helio + CMB_SPEED * projection
    d = vcmb / H0
    mask = np.isfinite(d) & (d > 1.0) & (d < 350.0)
    ra, dec, d, vcmb = ra[mask], dec[mask], d[mask], vcmb[mask]
    print(f"[local_layer] 2MRS: rows_in={n_in:,} kept(1<D<350)={len(ra):,}")
    return ra, dec, d, vcmb / C_KMS


def _dedupe_2mrs_against_cf4(mrs_ra, mrs_dec, mrs_cz_c, cf4_ra, cf4_dec, cf4_cz_c):
    """Drop 2MRS rows within 30 arcsec AND 300 km/s of any CF4 entry.
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
    # Galaxy coordinates are precise; 30 arcminutes merges distinct cluster
    # members. Thirty arcseconds is generous enough for catalog astrometry.
    ang_tol_deg = 30.0 / 3600.0

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


def _write_layer(name, ra, dec, d, redshift) -> dict:
    xyz = radec_to_xyz(ra, dec, d)
    order = np.argsort(d)
    xyz, redshift, d = xyz[order], redshift[order], d[order]
    fname = f"{name}_shell00.bin"
    nbytes = write_xyz_scalar_shell(DATA_DIR / fname, xyz, redshift)
    print(f"  {name}: rows={len(d):,} D={d.min():.3f}..{d.max():.1f} Mpc bytes={nbytes:,}")
    return {
        "name": name,
        "files": [{
            "path": fname, "count": int(len(d)), "arrays": ["xyz", "z"],
            "dmin": float(d[0]), "dmax": float(d[-1]),
        }],
        "_rows_in": len(d), "_rows_out": len(d), "_bytes_out": nbytes,
    }


def build_layers() -> list[dict]:
    print("[local_layer] building 'local_cf4' + 'local_2mrs'")
    cf4_ra, cf4_dec, cf4_d, cf4_czc = _read_cf4()
    mrs_ra, mrs_dec, mrs_d, mrs_czc = _read_2mrs()

    keep = _dedupe_2mrs_against_cf4(mrs_ra, mrs_dec, mrs_czc, cf4_ra, cf4_dec, cf4_czc)
    n_dropped = int((~keep).sum())
    mrs_ra, mrs_dec, mrs_d, mrs_czc = mrs_ra[keep], mrs_dec[keep], mrs_d[keep], mrs_czc[keep]
    print(f"[local_layer] 2MRS exact-sky dedupe: dropped {n_dropped:,}, kept {len(mrs_ra):,}")

    return [
        _write_layer("local_cf4", cf4_ra, cf4_dec, cf4_d, cf4_czc),
        _write_layer("local_2mrs", mrs_ra, mrs_dec, mrs_d, mrs_czc),
    ]


def build_layer() -> list[dict]:
    """Backward-compatible CLI entrypoint."""
    return build_layers()
