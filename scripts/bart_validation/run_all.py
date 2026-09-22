#!/usr/bin/env python3
"""End-to-end: validate the AC Transit app's ipf_od against BART ground-truth O-D.

Downloads BART's station-to-station O-D file and GTFS feed, builds a mean-weekday
AM (05:00-08:59) truth matrix, discards it down to marginals, re-infers with the
project's ipf_od, and scores the reconstruction.

    python3 run_all.py            # full pipeline (downloads if files absent)

Outputs: od_am_matrix.parquet, line_sequences.json, results_main.json,
per_line_direction_metrics.csv, backward_weight_sweep*.csv, displayed.json.
"""
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
    "stage7_displayed.py", "stage8_check.py",
]


def fetch():
    od = HERE / f"od-{YEAR}.csv.gz"
    if not od.exists():
        print(f"downloading {OD_URL} ...")
        urllib.request.urlretrieve(OD_URL, od)
    gz = HERE / "gtfs.zip"
    if not (HERE / "gtfs" / "stop_times.txt").exists():
        print(f"downloading {GTFS_URL} ...")
        urllib.request.urlretrieve(GTFS_URL, gz)
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
