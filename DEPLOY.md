# Deployment runbook

Operational reference for deploying this project. Written to be followed
step by step without prior context.

## Architecture

Two independent pieces:

- **The app** — a Next.js server in a container on Cloud Run. Small (~150 MB
  image); carries no data.
- **The data** — a ~58 MB bundle of JSON and packed typed arrays in a public
  GCS bucket. The browser fetches it directly from the bucket, cross-origin.
  It is never served by Cloud Run and is not in the container or in git.

The app finds the data through `NEXT_PUBLIC_PACK_BASE`. That is the only wire
between the two.

## Fixed values

| Thing | Value |
| --- | --- |
| GCP project | `ac-transit-visualizer` |
| Project number | `385939155005` |
| Region | `us-west1` |
| Cloud Run service | `ac-transit-ridership` |
| Live URL | `https://ac-transit-ridership-385939155005.us-west1.run.app` |
| Data bucket | `gs://ac-transit-ridership-pack` |
| Data base URL | `https://storage.googleapis.com/ac-transit-ridership-pack/pack` |
| Build service account | `385939155005-compute@developer.gserviceaccount.com` |
| HF dataset | `somemone/ac-transit-apc` |

## Prerequisites

```bash
gcloud --version      # Google Cloud SDK
docker --version      # only for local image builds; Cloud Build has its own
node --version        # 22+
gcloud auth list      # must show an active account with project access
gcloud config set project ac-transit-visualizer
```

## One-time project setup

Already done for `ac-transit-visualizer`. Repeat only for a fresh project.

### 1. Enable APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

### 2. Grant the build service account its roles

Cloud Build runs as the default compute service account. Without these the
build fails before it starts, with a `PERMISSION_DENIED` on reading the
uploaded source archive.

```bash
SA=385939155005-compute@developer.gserviceaccount.com
for ROLE in roles/cloudbuild.builds.builder roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding ac-transit-visualizer \
    --member="serviceAccount:$SA" --role="$ROLE" --condition=None
done
```

### 3. Create the data bucket

```bash
gcloud storage buckets create gs://ac-transit-ridership-pack \
  --location=us-west1 --uniform-bucket-level-access
```

### 4. Allow cross-origin reads

The browser loads the bundle from `storage.googleapis.com` while the page is
served from `run.app`. Without CORS every data fetch fails and the map renders
empty with no server-side error.

```bash
cat > /tmp/cors.json <<'EOF'
[{"origin":["*"],"method":["GET","HEAD"],
  "responseHeader":["Content-Type","Content-Length","Range","Accept-Ranges"],
  "maxAgeSeconds":3600}]
EOF
gcloud storage buckets update gs://ac-transit-ridership-pack --cors-file=/tmp/cors.json
```

### 5. Make the bucket world-readable

```bash
gcloud storage buckets add-iam-policy-binding gs://ac-transit-ridership-pack \
  --member=allUsers --role=roles/storage.objectViewer
```

## Deploying the app

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_CARTO_KEY=<key>,_TAG=$(git rev-parse --short HEAD)
```

`cloudbuild.yaml` runs three steps: build, push, deploy. Takes about 4 minutes.

**`NEXT_PUBLIC_*` values must be build args, not Cloud Run env vars.**
`next build` inlines them into the client JavaScript bundle. Setting them on
the service with `--set-env-vars` after the fact has no effect at all — the
value is already frozen into the shipped bundle. This is the single most
common way to waste time here.

`_CARTO_KEY` is the CARTO basemap key, supplied by the operator and
deliberately not stored in this repo. Omitting it is supported: the map falls
back to OpenStreetMap tiles and everything still works. Two caveats — do not
"fix" a missing key by removing the `key=` parameter from the CARTO URL, as
the keyless CARTO endpoint serves tiles watermarked `API KEY REQUIRED`; and
OSM's usage policy discourages aiming production traffic at
`tile.openstreetmap.org`, so the fallback is not a permanent home.

A bare `gcloud run deploy --source .` also works and picks up the
`NEXT_PUBLIC_PACK_BASE` default from the Dockerfile, but has no way to pass
the CARTO key, so it always lands on the OSM fallback.

## Updating the data bundle

Regenerate the bundle into `public/data/pack/`, then:

```bash
# 1. Upload. --gzip-local-all stores objects compressed (58 MB -> 33 MB);
#    browsers decode transparently. Do not use --gzip-in-flight-all, which
#    compresses only the transfer and stores the objects uncompressed.
gcloud storage cp -r public/data/pack/* gs://ac-transit-ridership-pack/pack/ \
  --gzip-local-all --cache-control="public, max-age=86400"

# 2. Regenerate the manifest that `npm run fetch:pack` reads.
python3 -c "
import json, os
os.chdir('public/data/pack')
files = sorted(f for f in os.listdir('.') if not f.startswith('.'))
json.dump({'files': files, 'count': len(files),
           'bytes': sum(os.path.getsize(f) for f in files)},
          open('/tmp/manifest.json','w'), indent=1)
"
gcloud storage cp /tmp/manifest.json \
  gs://ac-transit-ridership-pack/pack/manifest.json \
  --cache-control="public, max-age=300"
```

No redeploy is needed — the app reads the bucket at run time. Objects carry a
one-day cache lifetime, so a change can take up to 24 h to reach browsers that
already loaded the old copy. To force it sooner, upload under a new prefix and
rebuild with `_PACK_BASE` pointing at it.

## Verifying a deploy

```bash
URL=https://ac-transit-ridership-385939155005.us-west1.run.app

# Server responds
curl -sS -o /dev/null -w 'http=%{http_code}\n' "$URL/"

# The client bundle points at the bucket, and carries a CARTO key
CHUNK=$(curl -sS "$URL/" | grep -o '/_next/static/chunks/app/page-[a-z0-9]*\.js' | head -1)
curl -sS "$URL$CHUNK" | grep -c 'storage.googleapis.com/ac-transit-ridership-pack/pack'
curl -sS "$URL$CHUNK" | grep -c 'basemaps.cartocdn.com'

# The bucket serves, and gzip decodes to the right size
curl -sS --compressed -o /tmp/m.json \
  https://storage.googleapis.com/ac-transit-ridership-pack/pack/meta.json
wc -c < /tmp/m.json      # expect 3281152
```

A `curl` check is not sufficient on its own: the data load is client-side, so
the page can return HTTP 200 with a completely empty map. Open the live URL in
a browser and confirm dots render, or check that requests to
`storage.googleapis.com/ac-transit-ridership-pack/` return 200 in devtools.

## Troubleshooting

**`PERMISSION_DENIED` ... `could not resolve source` at build start.**
The build service account is missing roles. Run one-time setup step 2.

**`Image '...:<tag>' not found` during the deploy step.**
The image was built but not pushed. Cloud Build's top-level `images:` block
pushes only *after every step completes*, so a deploy step inside the same
build cannot see it. `cloudbuild.yaml` therefore has an explicit `push` step
between build and deploy — keep it.

**Map renders but the basemap is blank, watermarked, or plain OSM.**
`_CARTO_KEY` was not passed to the build. It cannot be added afterwards as a
runtime env var; rebuild.

**Map renders with a basemap but no data dots.**
Bucket CORS or public-read is missing, or `NEXT_PUBLIC_PACK_BASE` is wrong.
Check the browser console for CORS errors and confirm
`curl https://storage.googleapis.com/ac-transit-ridership-pack/pack/meta.json`
returns 200 from an unauthenticated shell.

**Data changes are not visible.**
The one-day `Cache-Control` on the objects. Hard-reload, or use a new prefix.

## Mirroring the dataset to HuggingFace

Only needed when new months land in `gs://ac-transit-stops`.

Requires an HF token with **write** scope (`hf auth login`; a read-scoped
token authenticates fine and fails every write with a 403). Run `hf auth
login` in a real terminal — it uses `getpass`, which raises `EOFError` where
there is no TTY.

The dataset is ~5.9 GB. Stage one file at a time rather than downloading it
all: the machine this was built on had under 8 GB free. Retry each transfer —
sustained runs failed twice with `OSError(65) No route to host` after 10–15
files, which is connection-level flakiness, not a bad file. Uploads are
idempotent, so re-running skips whatever already landed. A working script,
including the retry loop, is in this session's scratchpad as `hf_upload2.py`.
