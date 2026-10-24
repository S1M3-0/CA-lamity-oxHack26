"""Deterministic, source-checked raster preparation for TerraShift.

Only this offline module imports rasterio, numpy, pyproj, shapely, and matplotlib.
Remote full source files are cached locally outside git while their published
source records keep durable public URLs and SHA-256 values.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
from pathlib import Path
from urllib.request import urlopen

os.environ.setdefault("MPLCONFIGDIR", "/private/tmp/terrashift-matplotlib")

import numpy as np
import rasterio
from matplotlib import pyplot as plt
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject
from shapely.geometry import Polygon, shape
from shapely.ops import transform as shape_transform

ROOT = Path(__file__).resolve().parents[1]
MANIFESTS = Path(__file__).resolve().parent / "manifests"
CACHE = ROOT / "data" / "source-cache"
QA = ROOT / "data" / "qa"
PREPARED = ROOT / "data" / "prepared"
MAGIC = b"TSGRID1\n"
VERSION = "ts-fuel-proxy-1"


class SourceError(RuntimeError):
    """Source metadata, data coverage, or integrity prevents publication."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _source_path(product: str, band: str | None = None) -> Path:
    name = product + ("_" + band if band else "") + ".tif"
    return CACHE / name


def _verified_file(info: dict, product: str, band: str | None = None) -> Path:
    """Download full COG if needed and verify its declared SHA-256 and size."""
    expected = info.get("sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise SourceError(f"No pinned SHA-256 for {product} {band or ''}")
    url = info.get("url", "")
    if not url.startswith("https://"):
        raise SourceError(f"Only HTTPS source URLs are allowed: {product}")
    CACHE.mkdir(parents=True, exist_ok=True)
    path = _source_path(product, band)
    if path.exists() and _sha256(path) == expected:
        return path
    if path.exists():
        raise SourceError(f"Cached source checksum mismatch: {path}")
    temp = path.with_suffix(".part")
    try:
        with urlopen(url, timeout=90) as src, temp.open("wb") as dst:
            for block in iter(lambda: src.read(1024 * 1024), b""):
                dst.write(block)
        if info.get("sizeBytes") is not None and temp.stat().st_size != info["sizeBytes"]:
            raise SourceError(f"Source size mismatch: {product} {band or ''}")
        if _sha256(temp) != expected:
            raise SourceError(f"Source SHA-256 mismatch: {product} {band or ''}")
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)
    return path


def _manifest(slug: str) -> dict:
    path = MANIFESTS / f"{slug}.json"
    manifest = json.loads(path.read_text())
    if manifest.get("manifestVersion") != "ts-manifest-1" or manifest.get("place") != slug:
        raise SourceError("Manifest version or place mismatch")
    if manifest.get("processingVersion") != VERSION:
        raise SourceError("Unknown fuel processing version")
    if manifest.get("grid") != {"width": 200, "height": 200, "cellSizeM": 60}:
        raise SourceError("Grid must be 200 x 200 at 60 metres")
    if len(manifest["imagery"]["scenes"]) < 1 or len(manifest["dem"]["tiles"]) < 1:
        raise SourceError("Imagery and DEM sources are required")
    return manifest


def _grid(manifest: dict) -> tuple:
    crs = manifest["crs"]
    to_metric = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    cx, cy = to_metric.transform(*manifest["center"])
    if not math.isfinite(cx) or not math.isfinite(cy):
        raise SourceError("Place centre cannot be projected")
    x0, y0 = cx - 6000, cy + 6000
    affine = from_origin(x0, y0, 60, 60)
    metric_corners = [(x0, y0), (x0 + 12000, y0), (x0 + 12000, y0 - 12000), (x0, y0 - 12000)]
    corners = [[float(a), float(b)] for a, b in (to_wgs84.transform(x, y) for x, y in metric_corners)]
    footprint = {"type": "Polygon", "coordinates": [corners + [corners[0]]]}
    return affine, corners, footprint, to_metric


def _assert_raster(path: Path, info: dict, *, band: str) -> None:
    with rasterio.open(path) as src:
        if src.count != 1 or str(src.crs) != info["crs"]:
            raise SourceError(f"CRS or band count mismatch: {path}")
        nodata = info.get("nodata")
        if src.nodata != nodata:
            raise SourceError(f"No-data code mismatch: {path}: {src.nodata} != {nodata}")
        if band != "DEM":
            expected = info["resolutionM"]
            if abs(src.res[0] - expected) > 0.001 or abs(abs(src.res[1]) - expected) > 0.001:
                raise SourceError(f"Resolution mismatch: {path}")
            if band in ("B04", "B08") and (info.get("scale") != 0.0001 or not -0.2 <= info.get("offset", -1) <= 0):
                raise SourceError(f"Reflectance scale or offset mismatch: {path}")
        elif info.get("unit") != "metre" or info.get("verticalDatum") != "EGM2008":
            raise SourceError("DEM units or vertical datum unresolved")


def _warp(path: Path, info: dict, dst_shape: tuple[int, int], dst_affine, dst_crs: str, resampling: Resampling) -> np.ndarray:
    dst = np.full(dst_shape, np.nan, dtype=np.float32)
    with rasterio.open(path) as src:
        reproject(
            source=rasterio.band(src, 1), destination=dst,
            src_transform=src.transform, src_crs=src.crs, src_nodata=src.nodata,
            dst_transform=dst_affine, dst_crs=dst_crs, dst_nodata=np.nan,
            resampling=resampling, init_dest_nodata=True,
        )
    return dst


def _fuel_proxy(ndvi: np.ndarray, scl: np.ndarray, rule: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Versioned SCL/NDVI rule; this is a fuel proxy, not validated fuel."""
    if rule["ndviMin"] != 0.2 or rule["ndviMax"] != 0.8:
        raise SourceError("Unsupported fuel threshold version")
    scl = scl.astype(np.uint8, copy=False)
    veg = scl == 4
    bare = scl == 5
    water = scl == 6
    valid = (veg & np.isfinite(ndvi)) | bare | water
    fuel = np.zeros(ndvi.shape, dtype=np.float32)
    fuel[veg & np.isfinite(ndvi)] = np.clip((ndvi[veg & np.isfinite(ndvi)] - 0.2) / 0.6, 0, 1)
    return fuel, valid, water


def _imagery(manifest: dict, affine) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[dict]]:
    crs = manifest["crs"]
    fine_affine = from_origin(affine.c, affine.f, 10, 10)
    fine_shape = (1200, 1200)
    fuel = np.zeros(fine_shape, dtype=np.float32)
    valid = np.zeros(fine_shape, dtype=bool)
    water = np.zeros(fine_shape, dtype=bool)
    used = []
    for scene in manifest["imagery"]["scenes"]:
        assets = scene["assets"]
        paths = {b: _verified_file(assets[b], scene["product"], b) for b in ("B04", "B08", "SCL")}
        for b in paths:
            _assert_raster(paths[b], assets[b], band=b)
        red = _warp(paths["B04"], assets["B04"], fine_shape, fine_affine, crs, Resampling.nearest)
        nir = _warp(paths["B08"], assets["B08"], fine_shape, fine_affine, crs, Resampling.nearest)
        scl = _warp(paths["SCL"], assets["SCL"], fine_shape, fine_affine, crs, Resampling.nearest)
        red = red * assets["B04"]["scale"] + assets["B04"]["offset"]
        nir = nir * assets["B08"]["scale"] + assets["B08"]["offset"]
        denom = red + nir
        ndvi = np.divide(nir - red, denom, out=np.full(fine_shape, np.nan, dtype=np.float32), where=(denom > 0) & np.isfinite(denom))
        # SCL no-data and cloud classes remain invalid, including class 7.
        scene_fuel, scene_valid, scene_water = _fuel_proxy(ndvi, scl, manifest["fuelRule"])
        scene_valid &= np.isfinite(red) & np.isfinite(nir)
        new = ~valid & scene_valid
        fuel[new] = scene_fuel[new]
        water[new] = scene_water[new]
        valid[new] = True
        if np.any(new):
            used.append(scene)
        # A cell is resolved once at least 95% of its 10 m observations are valid.
        counts = valid.reshape(200, 6, 200, 6).sum(axis=(1, 3))
        if np.all(counts >= math.ceil(36 * manifest["fuelRule"]["minValidFractionPerCell"])):
            break
    count = valid.reshape(200, 6, 200, 6).sum(axis=(1, 3))
    min_count = math.ceil(36 * manifest["fuelRule"]["minValidFractionPerCell"])
    if np.any(count < min_count):
        raise SourceError(f"Unresolved Sentinel-2 imagery in {int(np.count_nonzero(count < min_count))} grid cells; minimum {min_count}/36 valid observations")
    fuel_grid = fuel.reshape(200, 6, 200, 6).sum(axis=(1, 3)) / count
    water_grid = water.reshape(200, 6, 200, 6).sum(axis=(1, 3)) / count >= 0.5
    fuel_grid[water_grid] = 0
    return fuel_grid.astype(np.float32), water_grid, count.astype(np.uint8), used


def _elevation(manifest: dict, affine) -> tuple[np.ndarray, list[dict]]:
    dst = np.full((200, 200), np.nan, dtype=np.float32)
    used = []
    for tile in manifest["dem"]["tiles"]:
        path = _verified_file(tile, tile["product"])
        _assert_raster(path, tile, band="DEM")
        warped = _warp(path, tile, (200, 200), affine, manifest["crs"], Resampling.bilinear)
        new = np.isnan(dst) & np.isfinite(warped)
        if np.any(new):
            dst[new] = warped[new]
            used.append(tile)
    if not np.isfinite(dst).all():
        raise SourceError(f"Elevation missing in {int(np.count_nonzero(~np.isfinite(dst)))} cells")
    if dst.min() < -500 or dst.max() > 9000:
        raise SourceError("Elevation metres outside plausible supported range")
    return dst, used


def _aoi(manifest: dict, metric_footprint: Polygon, to_metric) -> tuple[dict, dict]:
    p = (MANIFESTS / manifest["cityAoi"]["path"]).resolve()
    feature = json.loads(p.read_text())
    if feature.get("type") != "Feature" or feature.get("properties", {}).get("source") != manifest["cityAoi"]["source"]:
        raise SourceError("City AOI source mismatch")
    geom = shape(feature["geometry"])
    if not geom.is_valid or geom.is_empty:
        raise SourceError("City AOI geometry invalid")
    metric = shape_transform(to_metric.transform, geom)
    city_area = metric.area / 1e6
    intersection = metric.intersection(metric_footprint).area / 1e6
    coverage = {"cityAreaKm2": round(city_area, 3), "intersectionKm2": round(intersection, 3), "percent": round(100 * intersection / city_area, 2)}
    return feature, coverage


def _source_records(manifest: dict, scenes: list[dict], dem_tiles: list[dict]) -> list[dict]:
    records = []
    for tile in dem_tiles:
        records.append({"provider": manifest["dem"]["provider"], "product": tile["product"], "kind": "elevation-dsm", "url": tile["url"], "acquisition_start": "2011-01-01", "acquisition_end": "2015-12-31", "crs": tile["crs"], "resolution_m": tile["resolutionM"], "vertical_datum": tile["verticalDatum"], "licence": tile["licence"], "attribution": tile["attribution"], "sha256": tile["sha256"], "footprint": tile["footprint"]})
    for scene in scenes:
        for band, asset in scene["assets"].items():
            records.append({"provider": manifest["imagery"]["provider"], "product": scene["product"] + "/" + band, "kind": "sentinel2-" + band.lower(), "url": asset["url"], "acquisition_start": scene["acquisitionDate"], "acquisition_end": scene["acquisitionDate"], "crs": asset["crs"], "resolution_m": asset["resolutionM"], "vertical_datum": None, "licence": manifest["imagery"]["licence"], "attribution": manifest["imagery"]["attribution"], "sha256": asset["sha256"], "footprint": scene["footprint"]})
    return records


def _preview(slug: str, hazard: str, elev: np.ndarray, fuel: np.ndarray, corners: list, aoi: dict, coverage: dict) -> Path:
    QA.mkdir(parents=True, exist_ok=True)
    path = QA / f"{slug}-{hazard}.png"
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.6), constrained_layout=True)
    a = axes[0].imshow(elev, cmap="terrain")
    axes[0].set_title("Elevation (m) · GLO-30 DSM")
    fig.colorbar(a, ax=axes[0], shrink=0.7)
    b = axes[1].imshow(fuel, cmap="YlGn", vmin=0, vmax=1)
    axes[1].set_title("Sentinel-2 fuel proxy")
    fig.colorbar(b, ax=axes[1], shrink=0.7)
    poly = shape(aoi["geometry"])
    polys = list(poly.geoms) if hasattr(poly, "geoms") else [poly]
    for piece in polys:
        x, y = piece.exterior.xy
        axes[2].plot(x, y, color="#0284c7", linewidth=0.6)
    xx = [c[0] for c in corners] + [corners[0][0]]
    yy = [c[1] for c in corners] + [corners[0][1]]
    axes[2].plot(xx, yy, color="#e11d48", linewidth=2)
    axes[2].set_title(f"City AOI (blue) / 12 km grid (red)\n{coverage['percent']}% of city AOI")
    axes[2].set_aspect("equal", adjustable="datalim")
    for ax in axes[:2]:
        ax.set_xticks([])
        ax.set_yticks([])
    fig.savefig(path, dpi=140)
    plt.close(fig)
    return path


def prepare(slug: str, hazard: str, *, publish: bool = False) -> dict:
    if hazard not in ("wildfire", "flood"):
        raise SourceError("Unknown hazard")
    manifest = _manifest(slug)
    affine, corners, footprint, to_metric = _grid(manifest)
    # The transform and footprint are derived only once per city, for both hazards.
    x0, y0 = affine.c, affine.f
    metric_footprint = Polygon([(x0, y0), (x0 + 12000, y0), (x0 + 12000, y0 - 12000), (x0, y0 - 12000)])
    aoi, coverage = _aoi(manifest, metric_footprint, to_metric)
    elev, dem_tiles = _elevation(manifest, affine)
    fuel, water, valid_count, scenes = _imagery(manifest, affine)
    if not np.isfinite(fuel).all() or fuel.min() < 0 or fuel.max() > 1:
        raise SourceError("Fuel proxy contains missing/out-of-range cells")
    valid = np.ones((200, 200), dtype=np.uint8)
    water8 = water.astype(np.uint8)
    burnable = ((fuel > 0.2) & ~water).astype(np.uint8)
    sink = np.zeros((200, 200), dtype=np.uint8)
    # Every required cell is covered; ocean/drainage sinks remain separately zero
    # because no verified sink polygon is provided by this versioned manifest.
    blob = MAGIC + elev.astype("<f4").tobytes() + fuel.astype("<f4").tobytes() + valid.tobytes() + water8.tobytes() + burnable.tobytes() + sink.tobytes()
    if len(blob) != len(MAGIC) + 12 * 200 * 200:
        raise SourceError("Prepared array length mismatch")
    compressed = gzip.compress(blob, mtime=0)
    checksum = hashlib.sha256(compressed).hexdigest()
    acquisitions = sorted({s["acquisitionDate"] for s in scenes})
    asset_records = _source_records(manifest, scenes, dem_tiles)
    version_input = json.dumps({"place": slug, "hazard": hazard, "processingVersion": VERSION, "sources": [(a["product"], a["sha256"]) for a in asset_records]}, sort_keys=True).encode()
    version = "v1-" + hashlib.sha256(version_input).hexdigest()[:12]
    quality = {"centralAreaPrototype": True, "coverage": coverage, "elevationSourceType": "DSM", "demSourceDates": "2011–2015", "elevationMinM": float(elev.min()), "elevationMaxM": float(elev.max()), "fuelProxyMin": float(fuel.min()), "fuelProxyMax": float(fuel.max()), "validObservationMinPerCell": int(valid_count.min()), "validObservationMaxPerCell": int(valid_count.max()), "waterCellCount": int(water8.sum()), "burnableCellCount": int(burnable.sum()), "sinkCellCount": 0, "fuelRule": manifest["fuelRule"], "sinkRule": manifest["sinkRule"], "demLimitations": "Copernicus GLO-30 is a DSM with buildings and vegetation; flood depths are illustrative, not hydraulic predictions."}
    grid = {"place": slug, "hazard": hazard, "version": version, "crs": manifest["crs"], "transform": [float(affine.c), 60.0, 0.0, float(affine.f), 0.0, -60.0], "width": 200, "height": 200, "cellSizeM": 60, "footprint": footprint, "displayCorners": corners, "sourceDates": {"acquisitions": acquisitions, "dem": "2011-2015"}, "processingVersion": VERSION, "modelVersion": "ts-model-2", "quality": quality, "arrays": compressed, "checksum": checksum}
    PREPARED.mkdir(parents=True, exist_ok=True)
    (PREPARED / f"{slug}-{hazard}-{version}.bin.gz").write_bytes(compressed)
    preview = _preview(slug, hazard, elev, fuel, corners, aoi, coverage)
    report = QA / f"{slug}-{hazard}.md"
    report.write_text("\n".join([f"# {manifest['name']} · {hazard} · {version}", "", "Central-area prototype: 200 × 200 cells, 60 m, 12 × 12 km.", f"Metric CRS: {manifest['crs']}; transform: {grid['transform']}; row 0 north.", f"City AOI: {manifest['cityAoi']['source']} (OpenStreetMap ODbL 1.0, retrieved 2026-10-24).", f"City area: {coverage['cityAreaKm2']} km²; intersection: {coverage['intersectionKm2']} km²; covered: {coverage['percent']}%.", f"Sentinel-2 L2A dates: {', '.join(acquisitions)}; scenes: {', '.join(s['product'] for s in scenes)}.", f"DEM: Copernicus GLO-30 DSM, EGM2008 metres, 2011–2015; tiles: {', '.join(t['product'] for t in dem_tiles)}.", f"Elevation range: {elev.min():.2f} to {elev.max():.2f} m. Fuel proxy range: {fuel.min():.3f} to {fuel.max():.3f}.", f"Valid source observations per cell: {valid_count.min()}–{valid_count.max()} of 36. Water cells: {water8.sum()}; burnable cells: {burnable.sum()}; sink cells: 0.", f"Prepared codec: tsgrid1+gzip; SHA-256: {checksum}; compressed bytes: {len(compressed)}.", "Fuel proxy rule: SCL 4 eligible, SCL 5/6 zero, other classes invalid; NDVI 0.2→0, 0.8→1. Water uses SCL 6 majority per cell.", "Sink rule: none identified by verified mask source; zero mask. No elevation-threshold ocean inference.", "Limitations: GLO-30 is a DSM; NDVI is not validated combustible fuel; flood model is illustrative.", f"Preview: {preview}", ""]), encoding="utf-8")
    result = {"place": slug, "hazard": hazard, "version": version, "checksum": checksum, "sourceDates": acquisitions, "coverage": coverage, "preview": str(preview), "report": str(report), "compressedBytes": len(compressed), "published": False}
    if publish:
        from api.grid_repository import publish_grid, set_place_aoi
        set_place_aoi(slug, aoi["geometry"], manifest["cityAoi"]["source"])
        published = publish_grid(grid, asset_records)
        result["published"] = True
        result["database"] = published
    return result
