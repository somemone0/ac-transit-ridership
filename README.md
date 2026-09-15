# AC Transit Ridership Explorer

**Live: https://ac-transit-ridership-385939155005.us-west1.run.app**

An interactive map of stop-level bus ridership across the AC Transit network
from January 2019 through May 2026 — 387 weeks spanning the pandemic collapse
and the recovery that followed.

The data comes from the automatic passenger counters (APCs) on the buses
themselves: every door-open event, with boardings and alightings, at every
stop. That raw feed is corrected for partial fleet coverage, calibrated
against the agency's National Transit Database reports, and packed into a
binary bundle the browser can page through without a server round trip.

## What you can look at

- **Weekly ridership** at 2,987 stop groups (stops clustered within 100 m), 414
  census tracts, 1,099 block groups, or any of 174 routes.
- **Recovery** — each place's current ridership as a share of its
  February 2020 baseline, so you can see which corridors came back and which
  never did.
- **Corridors and sections** — ridership matched onto the road network, so
  routes that share a street share an edge and their loads add up there.
  Three GTFS eras (Nov 2019, Dec 2024, Aug 2025) are carried separately
  because stop sequences changed between them.
- **Commute patterns** — average-weekday hourly boarding and alighting
  profiles, plus inferred origin–destination flows for AM (5–9 a.m.) travel,
  at half-year snapshots from Feb 2019 to the present. The map is driven by a
  2×2 grid of measures: **AC Transit workplaces / homes** (bus commuters) over
  **All workplaces / All homes** (LEHD LODES primary jobs and employed
  residents per tract, one year per snapshot). Pick one cell to map how
  concentrated those commuters are; pick both cells of a column to map the
  ratio of the two concentrations, where 1× means bus commuters are
  distributed in proportion to all commuters.

  The AC Transit row counts *net round-trip* commuters rather than everyone
  who steps off a bus in the morning: a morning arrival alone cannot separate
  a commuter from a shopper, a student, or someone changing to BART, so a trip
  counts only when the same pair comes back in the evening (16–19), netted
  against the same pair's opposite direction so that an all-day two-way
  corridor scores near zero. Against LODES workplace-ness — log(jobs ÷
  resident workers) — this scores ρ 0.45 where raw morning arrivals score
  0.22, and it holds that across the 2019, 2023 and 2026 snapshots while raw
  arrivals decay. The evening window starts at 16:00 on purpose: schools
  dismiss 13–16 and their round trips mirror as cleanly as commutes do.

  The LODES cells are tract-level (that is what LODES publishes). UC
  employees are absent from LODES because the university sits outside State
  UI coverage, so Berkeley's campus tract reads far emptier than it is on the
  All-workplaces cell — while the AC round-trip cell ranks it a top-five
  destination, which is a good illustration of what each side can and cannot
  see.
- **Median household income** by tract and block group (ACS 5-year, 2024,
  table B19013) as an overlay.

Counts are split into *observed* and *imputed* components throughout. Where a
route–direction's APC coverage was too thin to trust, the shortfall is scaled
up and reported separately rather than silently folded in — the UI shows the
imputed share in parentheses.

## Running it

```bash
npm install
npm run fetch:pack   # ~58 MB of data into public/data/pack
npm run dev
```

`fetch:pack` pulls the bundle from the public GCS mirror. The bundle is not
committed — it is derived binary, and the deployed app reads it directly from
the bucket.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_PACK_BASE` | `/data/pack` | Where the browser loads the data bundle from. Unset it to use the local copy; point it at the bucket to serve the app without shipping the data. |
| `NEXT_PUBLIC_CARTO_KEY` | *(unset)* | Optional CARTO basemap key. Without one the map falls back to the standard OpenStreetMap tile server. |

Both are read at build time, since Next.js inlines `NEXT_PUBLIC_*` into the
client bundle.

## Data

### Packed bundle

The bundle the app reads lives in a public bucket:

```
https://storage.googleapis.com/ac-transit-ridership-pack/pack/
```

`manifest.json` lists every file. `meta.json` is the index — week labels,
stop-group coordinates and names, route lists per era, quantization scales —
and the `.bin` / `.u16` / `.u8` files are flat typed arrays it describes.
Objects are stored gzipped (58 MB → 33 MB on the wire) with a one-day cache
lifetime.

`lodes.json` is the one optional file the commute view's *All commuters* and
*Compare* modes read: LODES8 OD main tables (JT01 primary jobs) aggregated to
the app's 414 tracts, for 2019–2023, aligned with `meta.json`'s tracts array.
Build it with `scripts/build_lodes_pack.py` (downloads ~85 MB per year into
`vis/data/lodes_cache`, then sums by workplace and residence tract). A bundle
without it still works — those two modes just show a pointer to this script.

### Raw APC extracts

The underlying event-level data is published as a HuggingFace dataset:

**[`somemone/ac-transit-apc`](https://huggingface.co/datasets/somemone/ac-transit-apc)**

89 monthly Parquet files, ~5.9 GB, partitioned `year=/month=`, covering
Jan 2019 – May 2026. One row per stop event:

| column | type | notes |
| --- | --- | --- |
| `route` | string | route as reported by the vehicle |
| `route_id` | string | GTFS route identifier |
| `stop_id` | string | GTFS stop identifier |
| `event_timestamp` | timestamp[us] | when the doors opened |
| `service_date` | timestamp[us] | service day the event belongs to |
| `boardings` | int32 | passengers on |
| `alightings` | int32 | passengers off |
| `passenger_load` | int32 | load leaving the stop |
| `latitude`, `longitude` | double | stop position |
| `door_lift_flags_possibly` | string | vehicle flag field; its low bit separates the two APC-equipped subfleets |

```python
import pandas as pd

df = pd.read_parquet(
    "hf://datasets/somemone/ac-transit-apc/year=2019/month=2/data_0.parquet"
)
```

The records contain no operator, vehicle, or fare-media identifiers — nothing
that could identify a rider or a driver.

## Rebuilding the bundle

`scripts/build_commute_pack.py` builds the commute half of the bundle. It
needs two intermediates (the capture-rate table and the NTD calibration) that
live in sibling repositories not published here; point `ACPRA_ROOT` at a
checkout that has them, or set `ACPRA_REPLICATE` and `ACPRA_VIS` individually.
`ACPRA_BUCKET` overrides the raw-data source. `scripts/build_lodes_pack.py`
builds `lodes.json` (no sibling dependencies, only census.gov access). For
deployment both need uploading to the pack bucket and a line in its
`manifest.json`.

O–D flows are inferred, not observed. For each route–direction, stops are
ordered by how far into the trip the buses reach them, and every morning
trip's own boarding and alighting counts are fitted against a shared flow
matrix. The matrix is then rebuilt from the summed fits, over a few rounds
(iterative proportional fitting with an iteratively improved base, after Ji,
Mishalani & McCord 2014). Using trips one at a time keeps the information in
which stops fill up together on the same bus. Summing the whole month first
gives the most even matrix consistent with the totals, and that simpler fit
is still used where a held-out test on alternate days prefers it: thin
routes, and some with loops. The result is a reasonable picture of where a
corridor's morning riders are going in aggregate, not a record of any
individual trip.

Counts in the commute view are corrected for counter coverage by time of day
(early, AM peak, midday, PM peak, evening), because counters fail more often
at some hours than others. Weekly counts are spread from month totals to days
with the proportional Denton method, so they move smoothly across month
boundaries rather than stepping.

## Deployment

The app is containerized and runs on Cloud Run. The image carries only the
application; the browser fetches data from the bucket.

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_CARTO_KEY=<key>,_TAG=$(git rev-parse --short HEAD)
```

`cloudbuild.yaml` builds the image, pushes it, and rolls out the revision.
Both `NEXT_PUBLIC_*` values have to be set at *build* time, not as Cloud Run
env vars, because `next build` inlines them into the client bundle — setting
them on the service afterwards has no effect.

`_CARTO_KEY` is a substitution rather than a committed value. It is not really
a secret (every `NEXT_PUBLIC_*` value ships to the browser, so anyone can read
it out of the deployed bundle), but keeping it out of a public repo means it
cannot be scraped and charged against this account's tile quota without at
least visiting the site. Omit it and the map falls back to OpenStreetMap
tiles — which works, but pointing production traffic at
`tile.openstreetmap.org` is discouraged by their usage policy.

A plain `gcloud run deploy --source .` also works and picks up the
`NEXT_PUBLIC_PACK_BASE` default baked into the Dockerfile, but it has no way
to pass the CARTO key, so the map will be on the OSM fallback.

## Licenses

Code is [MIT](LICENSE). Data is
[CC BY 4.0](LICENSE-DATA) — the APC records originate with the
Alameda-Contra Costa Transit District. This project is not affiliated with or
endorsed by AC Transit.
