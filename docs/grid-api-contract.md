# TerraShift grid and API contract (v1)

This is a **central-area prototype**: each place has one north-up, 200 × 200,
60 m metric grid (12 × 12 km). Row 0 is north; all arrays and frames are
row-major. The two hazards for a place share the exact CRS, affine transform,
dimensions, and footprint. Place centres are Fort McMurray
(-111.38, 56.726; EPSG:32612), Oxford (-1.255, 51.745; EPSG:32630),
Brisbane (153.025, -27.47; EPSG:32756), and Los Angeles
(-118.2437, 34.0522; EPSG:32611). The ingest process verifies transformations.

## Prepared arrays

`grid_versions.array_codec = tsgrid1+gzip`. The uncompressed blob is ASCII
`TSGRID1\n`, followed by little-endian float32 elevation metres (N values),
little-endian float32 fuel proxy (N values in [0,1]), then four N-byte arrays
in this order: valid, water, burnable, sink. Masks contain only 0 or 1.
`sha256` is the hex digest of the complete compressed blob. Gzip uses `mtime=0`
for reproducibility. Required cells have finite elevation and resolved imagery;
publishing rejects any missing required cell. Sink means documented ocean or
drainage outlet, never an elevation threshold. Prepared blobs are immutable.

## HTTP

`GET /api/places` returns `{places:[{slug,name,center:[lon,lat],cityAoi,
cityAoiSource,coverage:{cityAreaKm2,intersectionKm2,percent}|null,
grids:{wildfire:{available,id,version}|null,flood:{...}|null}}]}`.
`cityAoi` is a GeoJSON geometry from PostGIS or null when unavailable.

`GET /api/grids/{place}/{hazard}` returns `{id,version,place,hazard,crs,
transform:[x0,60,0,y0,0,-60],width,height,cellSizeM,footprint,
displayCorners:[[lon,lat],...],sourceDates,processingVersion,modelVersion,
quality,fuelLabel:"fuel proxy"}`. Four display corners are NW, NE, SE, SW.
It never returns analytical arrays.

`POST /api/simulations` accepts `{place,hazard,origin:{longitude,latitude},
controls:{windSpeed,windDir,humidity,rainfall,saturation}}`. Origin is required
for both hazards. It must map to a valid starting cell; there is no snapping.
The response contains `{gridId,gridVersion,modelVersion,seed,origin:{cell,row,
col,center:[lon,lat]},geometry:{displayCorners,width,height,cellSizeM},
areaKm2:[97 numbers],frames:{codec:"gzip-uint8-frames-v1",width,height,
count:97,states:{...},data:<base64>}}`. Frame data is a single gzip stream of
97 consecutive row-major uint8 frames, `mtime=0`. Wildfire states are 0
unaffected, 110 burnt, 255 burning; flood is 0 below 0.15 m and 40–255 for
depth at or above threshold. Area counts every nonzero state × cell area.

Simulation uses a 24-hour horizon, 15-minute output, and the existing control
ranges. Model version `ts-model-2` preserves wildfire neighbour order and
seeded behaviour while replacing flood's sea-level heuristic with the explicit
sink mask. Runs are illustrative scenarios, not operational forecasts.

The repository function `api.grid_repository.get_active_grid(place, hazard)`
returns a dictionary with the metadata fields above plus compressed `arrays`
and `checksum`; it raises a clear unavailable/configuration/integrity error.
The simulation route decodes and validates that blob before running the model.
