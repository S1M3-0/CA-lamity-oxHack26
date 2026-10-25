"""Flood cellular automaton: rain runs downhill into river channels, and channels
spill onto the floodplain once they're over their banks.

Once per area:
  1. Known water (rivers, lakes) is burned into the elevation so channels are
     continuous, then pits are filled (Priority-Flood+epsilon) so every cell drains
     to the map edge or the sea instead of pooling in elevation-data noise.
  2. Each cell gets a D8 flow direction on that surface and an upstream area.
  3. Cells draining more than CHANNEL_KM2, and mapped water, are channels. Their
     bankfull depth and width grow with upstream area (hydraulic geometry).
Every time step:
  4. A storm hyetograph rains on every cell. The runoff coefficient (land cover,
     rising as the soil wets up) decides how much becomes surface water.
  5. Water takes one D8 step downhill at a Manning velocity: slow over forest,
     fast over pavement and in channels. Mapped rivers hold a standing baseflow
     (half full), and rivers entering the area bring extra inflow as the storm
     upstream drains.
  6. Water above a channel's banks, or ponding on the floodplain, also spreads
     sideways to lower water surfaces, which is what fills the floodplain.

Illustrative: the constants are textbook-scale guesses, not calibrated.
"""

import heapq
import math

import numpy as np

# Cell cover codes sent by the frontend.
LAND, WATER, SEA = 0, 1, 2

CHANNEL_KM2 = 0.5          # upstream area at which a stream becomes a channel
BURN_M = 2.0               # how far mapped water is lowered to carve continuous channels
FILL_EPS_M = 1e-3          # slope forced across filled flats so they still drain
MAPPED_BANK_M = 2.5        # bankfull depth of mapped rivers
BASEFLOW = 0.5             # share of bankfull that mapped rivers hold as standing water
N_CHANNEL = 0.035          # Manning roughness in channels
MIN_SLOPE = 1e-4
MAX_SPEED = 3.0            # m/s cap on any flow
DT_S = 60.0
SPREAD = 0.5               # share of a water-surface step equalised per time step
SPREAD_MIN_M = 0.1         # thinner water only flows downhill, it doesn't spread sideways
FLOODED_M = 0.15           # depth drawn as flooding
DEEP_SCALE_M = 2.5         # depth drawn at full colour
SOIL_WETS_UP_MM = 200.0    # rain after which the ground is fully saturated
ENTRY_CATCHMENT_KM2 = 5.0  # assumed area upstream of the map, per river cell crossing its edge
ENTRY_LAG_H = 3.0          # time for that upstream rain to arrive (linear reservoir)

# Frame values: 0 dry, RIVER = water inside a channel, 40..255 flood depth.
RIVER = 20

# (row, col) offsets for the 8 neighbours.
NEIGHBOURS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def rain_rate(hour: float, mean_mm_h: float, storm_hours: float) -> float:
    """Triangular storm: builds to a peak at 40% of its duration, then eases off.
    Averages `mean_mm_h` over `storm_hours`, so the total is mean_mm_h * storm_hours."""
    if storm_hours <= 0 or not 0 <= hour < storm_hours:
        return 0.0
    peak = 2 * mean_mm_h
    rise = 0.4 * storm_hours
    if hour < rise:
        return peak * hour / rise
    return peak * (storm_hours - hour) / (storm_hours - rise)


def rain_total(hour: float, mean_mm_h: float, storm_hours: float) -> float:
    """Rain fallen by `hour`, in mm."""
    if storm_hours <= 0:
        return 0.0
    h = min(max(hour, 0.0), storm_hours)
    rise = 0.4 * storm_hours
    peak = 2 * mean_mm_h
    if h <= rise:
        return 0.5 * peak * h * h / rise
    return 0.5 * peak * rise + 0.5 * (peak + rain_rate(h, mean_mm_h, storm_hours)) * (h - rise)


def _view(a: np.ndarray, dr: int, dc: int) -> np.ndarray:
    """The neighbour at offset (dr, dc) of every cell, from an array padded by one."""
    rows, cols = a.shape[0] - 2, a.shape[1] - 2
    return a[1 + dr:1 + dr + rows, 1 + dc:1 + dc + cols]


def condition(elevation: np.ndarray, cover: np.ndarray) -> np.ndarray:
    """Burn mapped water in, then fill pits so everything drains to the edge or the sea."""
    rows, cols = elevation.shape
    z = elevation.astype(np.float64) - BURN_M * (cover == WATER)
    filled = z.ravel().copy()
    done = np.zeros(rows * cols, dtype=bool)
    outlet = np.zeros((rows, cols), dtype=bool)
    outlet[0, :] = outlet[-1, :] = outlet[:, 0] = outlet[:, -1] = True
    outlet |= cover == SEA
    heap = [(filled[i], i) for i in np.flatnonzero(outlet)]
    heapq.heapify(heap)
    done[outlet.ravel()] = True
    while heap:
        zc, c = heapq.heappop(heap)
        r, col = divmod(c, cols)
        for dr, dc in NEIGHBOURS:
            nr, nc = r + dr, col + dc
            if 0 <= nr < rows and 0 <= nc < cols:
                n = nr * cols + nc
                if not done[n]:
                    done[n] = True
                    filled[n] = max(filled[n], zc + FILL_EPS_M)
                    heapq.heappush(heap, (filled[n], n))
    return filled.reshape(rows, cols)


def flow_directions(filled: np.ndarray, cover: np.ndarray, cell_m: float):
    """D8 downstream cell (flat index, -1 = leaves the map or reaches the sea),
    the drop's distance in metres and its slope."""
    rows, cols = filled.shape
    padded = np.pad(filled, 1, constant_values=np.inf)
    best = np.zeros_like(filled)
    down = np.full(filled.shape, -1, dtype=np.int64)
    dist = np.full(filled.shape, cell_m)
    rr, cc = np.indices(filled.shape)
    for dr, dc in NEIGHBOURS:
        d = cell_m * math.hypot(dr, dc)
        slope = (filled - _view(padded, dr, dc)) / d
        better = slope > best
        best = np.where(better, slope, best)
        down = np.where(better, (rr + dr) * cols + (cc + dc), down)
        dist = np.where(better, d, dist)
    down[cover == SEA] = -1
    return down.ravel(), dist.ravel(), np.maximum(best.ravel(), MIN_SLOPE)


def upstream_area(filled: np.ndarray, down: np.ndarray) -> np.ndarray:
    """Number of cells draining through each cell (itself included)."""
    acc = np.ones(filled.size)
    for c in np.argsort(filled.ravel())[::-1]:  # highest first
        if down[c] >= 0:
            acc[down[c]] += acc[c]
    return acc


def simulate(
    elevation: np.ndarray,
    cover: np.ndarray,
    runoff: np.ndarray,
    cell_m: float,
    rainfall_mm_h: float,
    storm_hours: float,
    saturation: float,
    num_frames: int = 96,
    minutes_per_frame: float = 15.0,
) -> tuple[np.ndarray, list[float]]:
    """Run a flood and return (frames, flooded km² per frame).

    elevation: metres. cover: LAND / WATER / SEA per cell. runoff: share of rain that
    runs off dry ground (0..1, from land cover). saturation: how wet the soil starts, 0..1.
    Frames are uint8: 0 dry, RIVER inside a channel, 40..255 flood depth up to DEEP_SCALE_M.
    """
    rows, cols = elevation.shape
    n_cells = rows * cols
    cell_area = cell_m * cell_m
    sea = (cover == SEA).ravel()
    mapped = (cover == WATER).ravel()

    filled = condition(elevation, cover)
    down, dist, slope = flow_directions(filled, cover, cell_m)
    area_km2 = upstream_area(filled, down) * cell_area / 1e6
    sqrt_slope = np.sqrt(slope)

    # Channel geometry: bankfull depth and width from upstream area; mapped rivers fill their cell.
    channel = (area_km2 >= CHANNEL_KM2) | mapped
    bank_depth = np.where(mapped, MAPPED_BANK_M, np.clip(0.35 * area_km2 ** 0.3, 0.3, 5.0))
    bank_width = np.where(mapped, cell_m, np.clip(4.0 * area_km2 ** 0.45, 2.0, cell_m))
    capacity = np.where(channel, bank_depth * bank_width / cell_m, 0.0)  # cell-average metres
    c_dry = np.clip(runoff.ravel().astype(np.float64), 0.0, 1.0)
    n_land = 0.03 + 0.12 * (1.0 - c_dry)  # pavement ~0.03, forest ~0.13

    # Rivers crossing into the map: edge cells of mapped water that drain inwards.
    edge = np.zeros((rows, cols), dtype=bool)
    edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
    entry = np.flatnonzero(mapped & edge.ravel() & (down >= 0))
    upstream_store = 0.0  # m³ waiting upstream of the map (linear reservoir)

    # Floodwater spreads over the pit-filled surface, so it doesn't drain into elevation-data
    # noise, but rivers keep their unburned bank height.
    ground = np.maximum(filled.ravel(), elevation.astype(np.float64).ravel())
    standing = np.where(mapped, BASEFLOW * capacity, 0.0)
    h = standing.copy()  # cell-average water depth, m

    steps_per_frame = max(1, round(minutes_per_frame * 60 / DT_S))
    dt_h = DT_S / 3600
    frames = np.zeros((num_frames + 1, rows, cols), dtype=np.uint8)
    areas: list[float] = []

    def snapshot(i: int) -> None:
        flood = np.maximum(h - capacity, 0.0)
        frame = np.zeros(n_cells, dtype=np.uint8)
        in_river = channel & (h >= 0.3 * capacity) & (h > 0)
        frame[in_river] = RIVER
        flooded = flood >= FLOODED_M
        frame[flooded] = np.minimum(255, 40 + np.round(flood[flooded] / DEEP_SCALE_M * 215)).astype(np.uint8)
        frames[i] = frame.reshape(rows, cols)
        areas.append(float(flooded.sum()) * cell_area / 1e6)

    snapshot(0)
    for step in range(1, num_frames * steps_per_frame + 1):
        hour = (step - 0.5) * dt_h

        # 4. Rain, and how much of it runs off as the soil wets up.
        rate_m = rain_rate(hour, rainfall_mm_h, storm_hours) / 1000 * dt_h
        sat = min(1.0, saturation + (1 - saturation) * rain_total(hour, rainfall_mm_h, storm_hours) / SOIL_WETS_UP_MM)
        c_eff = c_dry + (1 - c_dry) * sat * sat
        h += np.where(sea, 0.0, rate_m * c_eff)

        # Rivers entering the map bring the upstream storm, arriving late.
        if entry.size:
            upstream_store += rate_m * float(c_eff[entry].mean()) * ENTRY_CATCHMENT_KM2 * 1e6 * entry.size
            released = upstream_store * min(1.0, dt_h / ENTRY_LAG_H)
            upstream_store -= released
            h[entry] += released / cell_area / entry.size

        # 5. One D8 step downhill at Manning speed: in-channel water fast, overbank and sheet flow slower.
        # Baseflow in mapped rivers stands still (it's the steady river, fed from upstream);
        # only storm water above it moves on.
        in_channel = np.minimum(h, capacity)
        overland = h - in_channel
        channel_depth = np.where(channel, in_channel * cell_m / bank_width, 0.0)
        v_channel = np.minimum(channel_depth ** (2 / 3) * sqrt_slope / N_CHANNEL, MAX_SPEED)
        v_land = np.minimum(overland ** (2 / 3) * sqrt_slope / n_land, MAX_SPEED)
        move = (np.minimum(v_channel * DT_S / dist, 0.9) * np.maximum(in_channel - standing, 0.0)
                + np.minimum(v_land * DT_S / dist, 0.9) * overland)
        h -= move
        flows = down >= 0
        h += np.bincount(down[flows], weights=move[flows], minlength=n_cells)

        # 6. Water above the banks spreads sideways towards lower water surfaces.
        flood = np.maximum(h - capacity, 0.0).reshape(rows, cols)
        if flood.max() > SPREAD_MIN_M:
            surface = np.pad(ground.reshape(rows, cols) + flood, 1, constant_values=np.inf)
            mobile = np.where(flood > SPREAD_MIN_M, flood, 0.0)
            here = surface[1:-1, 1:-1]
            drops = [np.maximum(here - _view(surface, dr, dc), 0.0) for dr, dc in NEIGHBOURS]
            total = sum(drops)
            biggest = np.maximum.reduce(drops)
            out = np.minimum(mobile, biggest / 2) * SPREAD
            share = np.divide(out, total, out=np.zeros_like(out), where=total > 0)
            received = np.zeros((rows + 2, cols + 2))
            for (dr, dc), drop in zip(NEIGHBOURS, drops):
                _view(received, dr, dc)[...] += share * drop
            h += (received[1:-1, 1:-1] - out).ravel()

        h[sea] = 0.0
        np.maximum(h, 0.0, out=h)
        if step % steps_per_frame == 0:
            snapshot(step // steps_per_frame)

    return frames, areas
