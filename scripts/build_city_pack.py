"""Build the city level for the pack: cities.geojson + cities.json.

Cities are Census places (cartographic boundaries, California): incorporated cities plus
census-designated places, so the unincorporated communities AC Transit serves
heavily -- Castro Valley, Ashland, San Lorenzo, Cherryland -- are places of
their own instead of vanishing into a county remainder. Each stop group is
assigned to the place containing its centroid; groups outside every place
(freeway stops, the odd unincorporated gap) belong to no city and simply do
not count toward one.

Only places holding at least one stop group are kept, and their outlines are
simplified to ~20 m, which is well below anything the city zoom shows.

Outputs (public/data/pack/):
  cities.geojson   features with properties {geoid, name}
  cities.json      {places: [{geoid, name, kind}], group: [place index | -1]}
                   group is aligned with meta.json's stop_groups arrays.

The client sums stop-group weeks into cities, so no weekly binary is needed.
A bundle without these files hides the Cities level.

Usage: python3 scripts/build_city_pack.py
"""
import json
import os
import urllib.request
from pathlib import Path

import geopandas as gpd

NEXT = Path(__file__).resolve().parent.parent
PACK = Path(os.environ.get("ACPRA_PACK", NEXT / "public" / "data" / "pack"))
CACHE = Path(os.environ.get("ACPRA_VIS", NEXT.parent / "vis")) / "data" / "place_cache"
YEAR = 2024
# Cartographic boundary file: clipped to the shoreline, so San Francisco and
# Alameda do not paint the bay the way the TIGER/Line outlines do.
URL = f"https://www2.census.gov/geo/tiger/GENZ{YEAR}/shp/cb_{YEAR}_06_place_500k.zip"
SIMPLIFY_M = 20


def fetch():
    path = CACHE / f"cb_{YEAR}_06_place_500k.zip"
    if path.exists():
        return path
    CACHE.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(".part")
    urllib.request.urlretrieve(URL, part)
    part.rename(path)
    return path


def main():
    meta = json.loads((PACK / "meta.json").read_text())
    groups = meta["stop_groups"]
    places = gpd.read_file(f"zip://{fetch()}").to_crs(3310)
    points = gpd.GeoDataFrame(
        {"group": range(groups["n"])},
        geometry=gpd.points_from_xy(groups["lon"], groups["lat"]),
        crs=4326,
    ).to_crs(3310)
    joined = gpd.sjoin(points, places[["GEOID", "NAME", "LSAD", "geometry"]],
                       how="left", predicate="within")
    # a point on a shared boundary can land in two places; keep one
    joined = joined[~joined.index.duplicated()]

    used = places[places.GEOID.isin(joined.GEOID.dropna())].copy()
    used = used.sort_values("NAME").reset_index(drop=True)
    index = {geoid: i for i, geoid in enumerate(used.GEOID)}
    group_city = [index.get(g, -1) if isinstance(g, str) else -1 for g in joined.GEOID]

    used["geometry"] = used.geometry.simplify(SIMPLIFY_M)
    out = used.rename(columns={"GEOID": "geoid", "NAME": "name"})[["geoid", "name", "geometry"]]
    out.to_crs(4326).to_file(PACK / "cities.geojson", driver="GeoJSON", COORDINATE_PRECISION=5)
    (PACK / "cities.json").write_text(json.dumps({
        "source": f"Census cartographic boundary {YEAR} places (incorporated + CDP)",
        "places": [
            {"geoid": g, "name": n, "kind": "CDP" if lsad == "57" else "city"}
            for g, n, lsad in zip(used.GEOID, used.NAME, used.LSAD)
        ],
        "group": group_city,
    }, separators=(",", ":")))
    unassigned = sum(1 for c in group_city if c < 0)
    print(f"{len(used)} places; {unassigned}/{groups['n']} stop groups outside any place")


if __name__ == "__main__":
    main()
