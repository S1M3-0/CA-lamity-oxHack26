"""Wildfire spread cellular automaton.

Each cell of the area map is in one of three states:
  UNBURNT -> BURNING -> BURNT
A burning cell tries to ignite its 8 neighbours every step. The chance of
each ignition depends on the neighbour's fuel, the humidity, the wind and
(optionally) the slope. The wind and slope terms and their constants come
from Alexandridis et al. (2008); the fuel and humidity terms are our own
approximations and nothing here is calibrated against real fires:

  p = P0 * fuel * humidity_factor * wind_factor * slope_factor

The area map holds NLCD land-cover class codes, which set both how readily
a cell catches (fuel) and how long it burns. `simulate` returns frames
0..100 (frame 0 is the ignition) for the frontend to draw onto a canvas.

Grids are numpy arrays and each step only touches the box around the fire
front, so maps of a thousand cells a side stay quick.
"""

import math
from collections.abc import Iterable

import numpy as np

UNBURNT, BURNING, BURNT = 0, 1, 2

# Fuel (0..1) for each NLCD 2021 class. Classes not listed (water, ice, dense
# urban, no data) don't burn. Chaparral shrub and grass drive LA fires.
FUEL_BY_NLCD: dict[int, float] = {
    21: 0.35,  # developed, open space (parks, large lawns)
    22: 0.2,   # developed, low intensity
    23: 0.05,  # developed, medium intensity
    31: 0.05,  # barren
    41: 0.8,   # deciduous forest
    42: 0.9,   # evergreen forest
    43: 0.85,  # mixed forest
    52: 1.0,   # shrub/scrub (chaparral, coastal sage)
    71: 0.9,   # grassland
    81: 0.6,   # pasture/hay
    82: 0.4,   # cultivated crops
    90: 0.5,   # woody wetlands
    95: 0.4,   # emergent herbaceous wetlands
}

# Steps each class keeps burning: grass flashes through, timber smoulders.
BURN_STEPS_BY_NLCD: dict[int, int] = {
    21: 2, 22: 2, 23: 1, 31: 1, 41: 6, 42: 7, 43: 6,
    52: 4, 71: 1, 81: 1, 82: 2, 90: 4, 95: 2,
}

P0 = 0.58            # base spread probability between neighbouring cells
SPREAD_SPEED = 0.5  # automaton updates per requested step (half the original speed)
WIND_C1 = 0.045      # wind strength term, per m/s
WIND_C2 = 0.131      # wind alignment term, per m/s
SLOPE_A = 0.078      # slope term, per degree

# (row offset, col offset) from a burning cell to each of its 8 neighbours.
NEIGHBOURS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _lookup(table: dict[int, float], land_cover: np.ndarray, dtype) -> np.ndarray:
    lut = np.zeros(256, dtype=dtype)
    for code, value in table.items():
        lut[code] = value
    return lut[np.asarray(land_cover, dtype=np.uint8)]


def derive_fuel_map(area_map: np.ndarray) -> np.ndarray:
    """Turn an NLCD land-cover map into a fuel map (0 = nothing to burn, 1 = dense fuel)."""
    return _lookup(FUEL_BY_NLCD, area_map, np.float32)


def derive_burn_steps(area_map: np.ndarray) -> np.ndarray:
    """How many steps each cell keeps burning once lit."""
    return _lookup(BURN_STEPS_BY_NLCD, area_map, np.int16)


def _humidity_factor(humidity: float) -> float:
    """Dry air spreads fire faster. Drops to 0 at 100% relative humidity."""
    h = min(max(humidity, 0.0), 100.0) / 100.0
    return (1.0 - h) ** 1.5


def _wind_factor(wind_speed: float, wind_from_deg: float, dr: int, dc: int) -> float:
    """Boost spread in the downwind direction, damp it upwind.

    `wind_from_deg` uses the weather convention: the bearing the wind blows
    FROM, clockwise from north (270 = westerly wind, fire pushed east).
    """
    if wind_speed <= 0:
        return 1.0
    blow_to = math.radians((wind_from_deg + 180.0) % 360.0)
    # Grid rows grow southwards, so north is -row.
    spread = math.atan2(dc, -dr)
    cos_theta = math.cos(spread - blow_to)
    return math.exp(WIND_C1 * wind_speed) * math.exp(WIND_C2 * wind_speed * (cos_theta - 1.0))


def _shift(a: np.ndarray, dr: int, dc: int) -> np.ndarray:
    """out[r, c] = a[r - dr, c - dc], zero where that falls off the grid."""
    out = np.zeros_like(a)
    rows, cols = a.shape
    out[max(dr, 0):rows + min(dr, 0), max(dc, 0):cols + min(dc, 0)] = \
        a[max(-dr, 0):rows + min(-dr, 0), max(-dc, 0):cols + min(-dc, 0)]
    return out


def _spread_probabilities(fuel: np.ndarray, elevation: np.ndarray | None, cell_size: float,
                          wind_direction: float, wind_speed: float,
                          humidity: float) -> list[np.ndarray]:
    """For each neighbour offset, the chance a burning cell lights the cell that far away.

    Indexed by the receiving cell, so result[i][r, c] is the chance that a
    fire at (r, c) - NEIGHBOURS[i] spreads to (r, c). Weather and terrain are
    fixed for a run, so this is worked out once.
    """
    base = P0 * fuel * _humidity_factor(humidity)
    burnable = fuel > 0
    probs = []
    for dr, dc in NEIGHBOURS:
        p = base * _wind_factor(wind_speed, wind_direction, dr, dc)
        if dr and dc:
            # No slipping diagonally between two unburnable cells (a river or road at 45°).
            p = p * (_shift(burnable, dr, 0) | _shift(burnable, 0, dc))
        if elevation is not None:
            rise = elevation - _shift(elevation, dr, dc)
            slope_deg = np.degrees(np.arctan(rise / (cell_size * math.hypot(dr, dc))))
            p = p * np.exp(SLOPE_A * slope_deg)
        p = np.minimum(p, 1.0)
        if dr and dc:
            p = p ** math.sqrt(2)  # diagonal neighbours are further away
        probs.append(p.astype(np.float32))
    return probs


def simulate(
    area_map,
    ignition_points: Iterable[tuple[int, int]],
    wind_direction: float,
    wind_speed: float,
    humidity: float,
    fuel_map=None,
    elevation=None,
    cell_size: float = 30.0,
    num_frames: int = 100,
    steps_per_frame: int = 1,
    seed: int | None = None,
    hourly_weather: list[dict[str, float]] | None = None,
) -> np.ndarray:
    """Run the automaton and return frames 0..num_frames as a (frames, rows, cols) uint8 array.

    area_map:        2D NLCD land-cover grid (see FUEL_BY_NLCD).
    ignition_points: (row, col) cells burning at frame 0.
    wind_direction:  degrees the wind blows from, clockwise from north.
    wind_speed:      m/s.
    humidity:        relative humidity, 0..100 %.
    fuel_map:        override for the fuel derived from area_map.
    elevation:       optional 2D elevation grid in metres, same shape.
    cell_size:       metres per cell, used for slope.
    steps_per_frame: requested steps between saved frames, scaled by SPREAD_SPEED.
                     Fractional updates carry over to the next frame. Fire moves
                     at most one cell per update.
    seed:            fix for repeatable runs.
    """
    rng = np.random.default_rng(seed)
    area_map = np.asarray(area_map)
    fuel = derive_fuel_map(area_map) if fuel_map is None else np.asarray(fuel_map, dtype=np.float32)
    elevation = None if elevation is None else np.asarray(elevation, dtype=np.float32)
    rows, cols = fuel.shape
    burnable = fuel > 0
    burn_steps = np.maximum(derive_burn_steps(area_map), 1)

    probs = _spread_probabilities(fuel, elevation, cell_size, wind_direction, wind_speed, humidity)
    weather_hour = -1

    state = np.full((rows, cols), UNBURNT, dtype=np.uint8)
    burn_left = np.zeros((rows, cols), dtype=np.int16)
    for r, c in ignition_points:
        if 0 <= r < rows and 0 <= c < cols and burnable[r, c]:
            state[r, c] = BURNING
            burn_left[r, c] = burn_steps[r, c]

    frames = np.empty((num_frames + 1, rows, cols), dtype=np.uint8)
    frames[0] = state
    for frame in range(1, num_frames + 1):
        if hourly_weather:
            # The app's 96 intervals span 24 hours; don't accelerate weather with CA steps.
            hour = min(23, (frame - 1) // 4)
            if hour != weather_hour:
                weather_hour = hour
                weather = hourly_weather[hour]
                probs = _spread_probabilities(fuel, elevation, cell_size, weather["windDir"],
                                              weather["windSpeed"] / 3.6, weather["humidity"])
        start_step = math.floor((frame - 1) * steps_per_frame * SPREAD_SPEED)
        end_step = math.floor(frame * steps_per_frame * SPREAD_SPEED)
        for _ in range(start_step, end_step):
            burning_rows, burning_cols = np.nonzero(state == BURNING)
            if burning_rows.size:
                # Work only in the box around the fire, one cell wider on each side.
                r0, r1 = max(burning_rows.min() - 1, 0), min(burning_rows.max() + 2, rows)
                c0, c1 = max(burning_cols.min() - 1, 0), min(burning_cols.max() + 2, cols)
                win = (slice(r0, r1), slice(c0, c1))
                burning = (state[win] == BURNING).astype(np.float32)

                # Chance each cell escapes every burning neighbour this step.
                survive = np.ones_like(burning)
                for (dr, dc), p in zip(NEIGHBOURS, probs):
                    survive *= 1.0 - p[win] * _shift(burning, dr, dc)

                # Burning cells use up their fuel.
                lit = state[win] == BURNING
                burn_left[win][lit] -= 1
                state[win][lit & (burn_left[win] <= 0)] = BURNT

                catch = (state[win] == UNBURNT) & burnable[win] & (rng.random(survive.shape) >= survive)
                state[win][catch] = BURNING
                burn_left[win][catch] = burn_steps[win][catch]
        frames[frame] = state

    return frames


if __name__ == "__main__":
    # Demo on the real LA maps: a Santa Ana wind (from the north-east) over
    # the Santa Monica Mountains, lit near Topanga.
    from fire_maps import load_fire_maps

    maps = load_fire_maps((-118.80, 34.00, -118.40, 34.20), max_cells=300)
    start = maps.to_cell(-118.60, 34.10)
    frames = simulate(maps.land_cover, [start], wind_direction=45, wind_speed=12,
                      humidity=10, elevation=maps.elevation, cell_size=maps.cell_size, seed=1)
    cell_km2 = (maps.cell_size / 1000) ** 2
    print(f"grid {maps.shape}, {maps.cell_size:.0f} m cells, ignition at {start}")
    for i in (0, 10, 25, 50, 100):
        burning, burnt = (frames[i] == BURNING).sum(), (frames[i] == BURNT).sum()
        print(f"frame {i:3}: {burning:5} burning, {burnt:5} burnt, {(burning + burnt) * cell_km2:6.1f} km2")
