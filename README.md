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
  at half-year snapshots from Feb 2019 to the present.
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
`ACPRA_BUCKET` overrides the raw-data source.

O–D flows are inferred, not observed. Each route–direction's AM boarding and
alighting totals are used as the marginals of an iterative proportional
fitting (Furness) problem over the stop sequence, with a small weight allowed
for backward travel. The result is the most even flow matrix consistent with
the counts — it is a reasonable picture of where a corridor's morning riders
are going in aggregate, not a record of any individual trip.

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
