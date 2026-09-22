#!/usr/bin/env python3
"""End-to-end: validate the AC Transit app's ipf_od against BART ground-truth O-D.

Downloads BART's station-to-station O-D file and GTFS feed, builds a mean-weekday
AM (05:00-10:59) truth matrix, discards it down to marginals, re-infers with the
project's summed and per-trip fits, and scores the reconstruction.

    python3 run_all.py            # full pipeline (downloads if files absent)

Outputs: od_am_matrix.parquet, line_sequences.json, results_main.json,
per_line_direction_metrics.csv, backward_weight_sweep*.csv, displayed.json,
results_per_trip.json.
"""
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
YEAR = 2025
OD_URL = (f"https://afcweb.bart.gov/ridership/origin-destination/"
          f"date-hour-soo-dest-{YEAR}.csv.gz")
GTFS_URL = "https://www.bart.gov/dev/schedules/google_transit.zip"

STAGES = [
    "stage1_truth.py", "stage2_lines.py", "stage3_score.py",
    "stage4_sweep.py", "stage5_backward_fair.py", "stage6_diag.py",
    "stage7_displayed.py", "stage8_check.py", "stage9_per_trip.py",
]


def download(url, dest):
    """afcweb.bart.gov 403s urllib's default User-Agent; send a browser one."""
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X "
                                    "10_15_7) AppleWebKit/537.36 "
                                    "(KHTML, like Gecko) Chrome/124.0 "
                                    "Safari/537.36"})
    with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def fetch():
    od = HERE / f"od-{YEAR}.csv.gz"
    if not od.exists():
        print(f"downloading {OD_URL} ...")
        download(OD_URL, od)
    gz = HERE / "gtfs.zip"
    if not (HERE / "gtfs" / "stop_times.txt").exists():
        print(f"downloading {GTFS_URL} ...")
        download(GTFS_URL, gz)
        with zipfile.ZipFile(gz) as z:
            z.extractall(HERE / "gtfs")
    print("inputs ready")


def main():
    fetch()
    for s in STAGES:
        print(f"\n{'=' * 70}\n== {s}\n{'=' * 70}")
        r = subprocess.run([sys.executable, str(HERE / s)], cwd=HERE)
        if r.returncode != 0:
            sys.exit(f"stage failed: {s}")
    print("\nall stages complete -- see REPORT.md")


if __name__ == "__main__":
    main()
