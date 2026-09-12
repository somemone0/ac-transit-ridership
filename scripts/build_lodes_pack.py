"""Build lodes.json for the pack: LODES8 JT01 workplace and residence
marginals per tract, one value per year.

The OD main tables give both ends: summing S000 over all residences by
workplace tract yields primary jobs per tract; summing over all workplaces by
residence tract yields resident workers per tract. Values align with
meta.json's tracts array order, so the client needs no join.

Output: public/data/pack/lodes.json (served like the rest of the bundle; run
scripts/sync-pack.mjs / gcloud upload to publish).

Usage: python3 scripts/build_lodes_pack.py
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

import pandas as pd

NEXT = Path(__file__).resolve().parent.parent
PACK = Path(os.environ.get("ACPRA_PACK", NEXT / "public" / "data" / "pack"))
CACHE = Path(os.environ.get("ACPRA_VIS", NEXT.parent / "vis")) / "data" / "lodes_cache"
BASE = "https://lehd.ces.census.gov/data/lodes/LODES8/ca/od"
YEARS = range(2019, 2024)


def fetch(year):
    path = CACHE / f"ca_od_main_JT01_{year}.csv.gz"
    if not path.exists():
        url = f"{BASE}/ca_od_main_JT01_{year}.csv.gz"
        print(f"downloading {url}")
        req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=600) as resp, open(path, "wb") as out:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
    return path


def marginals(year, tracts, counties):
    """(jobs by workplace tract, workers by residence tract) for one year.

    The residence side must sum over every workplace, and the workplace side
    over every residence, so the county filter can only drop the *other* end:
    keep rows whose workplace is ours (residence anywhere) for jobs, rows
    whose residence is ours (workplace anywhere) for workers.
    """
    path = fetch(year)
    jobs = pd.Series(0.0, index=tracts)
    workers = pd.Series(0.0, index=tracts)
    for chunk in pd.read_csv(path, usecols=["w_geocode", "h_geocode", "S000"],
                             dtype={"w_geocode": str, "h_geocode": str},
                             chunksize=2_000_000):
        wc = chunk.w_geocode.str[:5].isin(counties)
        hc = chunk.h_geocode.str[:5].isin(counties)
        j = chunk[wc].groupby(chunk.w_geocode[wc].str[:11]).S000.sum()
        w = chunk[hc].groupby(chunk.h_geocode[hc].str[:11]).S000.sum()
        j = j[j.index.isin(tracts)]
        w = w[w.index.isin(tracts)]
        jobs[j.index] += j.to_numpy()
        workers[w.index] += w.to_numpy()
    return jobs, workers


def main():
    meta = json.loads((PACK / "meta.json").read_text())
    tracts = meta["tracts"]
    counties = sorted({g[:5] for g in tracts})
    out = {"years": [], "jobs": {}, "workers": {}, "n": len(tracts),
           "source": "LODES8 ca_od_main_JT01 (primary jobs), block geographies aggregated to tracts",
           "note": "indexed like meta.json tracts; jobs = primary jobs located in the tract "
                   "(any residence), workers = employed residents of the tract (any workplace)"}
    for year in YEARS:
        jobs, workers = marginals(year, tracts, counties)
        out["years"].append(year)
        out["jobs"][str(year)] = [round(float(v)) for v in jobs]
        out["workers"][str(year)] = [round(float(v)) for v in workers]
        print(f"{year}: {jobs.sum():,.0f} primary jobs, {workers.sum():,.0f} resident workers "
              f"in {len(tracts)} tracts")
    target = PACK / "lodes.json"
    payload = json.dumps(out, separators=(",", ":")).encode()
    target.write_bytes(payload)
    print(f"wrote {target} ({len(payload) / 1e3:.0f} KB)")


if __name__ == "__main__":
    sys.exit(main())
