"""Build pack_index.json: the few whole-bundle numbers the client needs before
it has loaded the data they summarise.

The client loads schedule-period (era) corridor data only when the time bar
reaches that era, so it can no longer compute a colour domain over all eras at
startup. The corridor ramp's domain is computed here with the same rule as
corridorDomain() in components/ridership-data.js -- the 98th percentile of
weekly corridor load, sampled every fourth week of each era, over weeks that
fall in a month the bundle covers -- so the colours do not shift as eras load.

Run it after anything that changes meta.json or the section loads.

Usage: python3 scripts/build_pack_index.py
"""
import json
import os
from pathlib import Path

import numpy as np

NEXT = Path(__file__).resolve().parent.parent
PACK = Path(os.environ.get("ACPRA_PACK", NEXT / "public" / "data" / "pack"))


def corridor_samples(meta, era, spec, month_index):
    features = json.loads((PACK / f"corridors_{era}.json").read_text())
    load = np.fromfile(PACK / f"section_load_{era}.u16", dtype="<u2").astype(np.float64)
    n_weeks = spec["n_weeks"]
    load = load.reshape(-1, n_weeks) * np.asarray(spec["scale"])[:, None]
    row = {sid: i for i, sid in enumerate(spec["section_ids"])}
    totals = np.zeros((len(features), n_weeks))
    for index, feature in enumerate(features):
        rows = [row[sid] for sid in feature["s"] if sid in row]
        if rows:
            totals[index] = load[rows].sum(axis=0)
    weeks = [w for w in range(0, n_weeks, 4) if month_index[spec["week_lo"] + w] >= 0]
    sample = totals[:, weeks].ravel()
    # the client sums float32 loads; match its precision before comparing to 0
    sample = sample.astype(np.float32)
    return sample[sample > 0]


def main():
    meta = json.loads((PACK / "meta.json").read_text())
    month_index = [meta["months"].index(w[:7]) if w[:7] in meta["months"] else -1
                   for w in meta["weeks"]]
    samples = np.concatenate([
        corridor_samples(meta, era, spec, month_index) for era, spec in meta["sections"].items()
    ])
    samples.sort()
    domain = float(samples[int(len(samples) * 0.98)]) if len(samples) else 1.0
    out = {"corridor_domain": round(domain, 3)}
    (PACK / "pack_index.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"pack_index.json: corridor domain {domain:,.1f} from {len(samples):,} samples")


if __name__ == "__main__":
    main()
