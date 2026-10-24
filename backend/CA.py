"""Wildfire spread cellular automaton.

Each cell of the area map is in one of three states:
  UNBURNT -> BURNING -> BURNT
A burning cell tries to ignite its 8 neighbours every step. The chance of
each ignition depends on the neighbour's fuel, the humidity, the wind and
(optionally) the slope, following Alexandridis et al. (2008):

  p = P0 * fuel * humidity_factor * wind_factor * slope_factor

Cells with more fuel burn for longer. `simulate` returns frames 0..100
(frame 0 is the ignition) so the frontend can draw them onto a canvas.

Pure Python on purpose: no extra dependencies to install. Only burning
cells are visited each step, so grids of a few hundred cells a side run fast.
"""

import math
import random
from collections.abc import Iterable, Sequence

UNBURNT, BURNING, BURNT = 0, 1, 2

# Fuel load (0..1) for each land-cover class in the area map. Classes that
# can't burn have fuel 0. Codes may be strings or ints.
FUEL_BY_LAND_COVER: dict[str | int, float] = {
    "water": 0.0, 0: 0.0,
    "bare": 0.0, 1: 0.0,
    "urban": 0.2, 2: 0.2,
    "grass": 0.6, 3: 0.6,
    "shrub": 0.85, 4: 0.85,
    "forest": 1.0, 5: 1.0,
}

P0 = 0.58            # base spread probability between neighbouring cells
WIND_C1 = 0.045      # wind strength term, per m/s
WIND_C2 = 0.131      # wind alignment term, per m/s
SLOPE_A = 0.078      # slope term, per degree
MAX_BURN_STEPS = 6   # how long a full-fuel cell keeps burning

# (row offset, col offset) for the 8 neighbours.
NEIGHBOURS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

Grid = list[list[int]]


def derive_fuel_map(area_map: Sequence[Sequence[str | int]]) -> list[list[float]]:
    """Turn a land-cover map into a fuel map (0 = nothing to burn, 1 = dense fuel)."""
    return [[FUEL_BY_LAND_COVER.get(cell, 0.0) for cell in row] for row in area_map]


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


def _slope_factor(elevation: Sequence[Sequence[float]] | None, cell_size: float,
                  r: int, c: int, nr: int, nc: int) -> float:
    """Fire runs faster uphill than downhill."""
    if elevation is None:
        return 1.0
    distance = cell_size * math.hypot(nr - r, nc - c)
    angle = math.degrees(math.atan((elevation[nr][nc] - elevation[r][c]) / distance))
    return math.exp(SLOPE_A * angle)


def simulate(
    area_map: Sequence[Sequence[str | int]],
    ignition_points: Iterable[tuple[int, int]],
    wind_direction: float,
    wind_speed: float,
    humidity: float,
    fuel_map: Sequence[Sequence[float]] | None = None,
    elevation: Sequence[Sequence[float]] | None = None,
    cell_size: float = 30.0,
    num_frames: int = 100,
    seed: int | None = None,
) -> list[Grid]:
    """Run the automaton and return frames 0..num_frames of cell states.

    area_map:        2D land-cover grid (see FUEL_BY_LAND_COVER).
    ignition_points: (row, col) cells burning at frame 0.
    wind_direction:  degrees the wind blows from, clockwise from north.
    wind_speed:      m/s.
    humidity:        relative humidity, 0..100 %.
    fuel_map:        override for the fuel derived from area_map.
    elevation:       optional 2D elevation grid in metres, same shape.
    cell_size:       metres per cell, used for slope.
    seed:            fix for repeatable runs.
    """
    rng = random.Random(seed)
    fuel = [list(row) for row in (fuel_map or derive_fuel_map(area_map))]
    rows, cols = len(fuel), len(fuel[0]) if fuel else 0

    # Per-direction factors don't change during a run, so compute them once.
    humid = _humidity_factor(humidity)
    wind = {(dr, dc): _wind_factor(wind_speed, wind_direction, dr, dc) for dr, dc in NEIGHBOURS}

    state = [[UNBURNT] * cols for _ in range(rows)]
    burn_left: dict[tuple[int, int], int] = {}

    def ignite(r: int, c: int) -> None:
        state[r][c] = BURNING
        burn_left[(r, c)] = max(1, round(MAX_BURN_STEPS * fuel[r][c]))

    for r, c in ignition_points:
        if 0 <= r < rows and 0 <= c < cols and fuel[r][c] > 0:
            ignite(r, c)

    frames = [[row[:] for row in state]]
    for _ in range(num_frames):
        # Chance each unburnt cell escapes every burning neighbour this step.
        survive: dict[tuple[int, int], float] = {}
        for (r, c) in burn_left:
            for dr, dc in NEIGHBOURS:
                nr, nc = r + dr, c + dc
                if not (0 <= nr < rows and 0 <= nc < cols):
                    continue
                if state[nr][nc] != UNBURNT or fuel[nr][nc] <= 0:
                    continue
                p = (P0 * fuel[nr][nc] * humid * wind[(dr, dc)]
                     * _slope_factor(elevation, cell_size, r, c, nr, nc))
                p = min(p, 1.0)
                if dr and dc:
                    p **= math.sqrt(2)  # diagonal neighbours are further away
                survive[(nr, nc)] = survive.get((nr, nc), 1.0) * (1.0 - p)

        # Burning cells use up their fuel.
        for cell in list(burn_left):
            burn_left[cell] -= 1
            if burn_left[cell] <= 0:
                del burn_left[cell]
                state[cell[0]][cell[1]] = BURNT

        for (r, c), s in survive.items():
            if rng.random() > s:
                ignite(r, c)

        frames.append([row[:] for row in state])

    return frames


def run_simulation(**kwargs) -> dict:
    """`simulate` wrapped in a JSON-ready payload for the frontend canvas."""
    frames = simulate(**kwargs)
    return {
        "height": len(frames[0]),
        "width": len(frames[0][0]) if frames[0] else 0,
        "states": {"unburnt": UNBURNT, "burning": BURNING, "burnt": BURNT},
        "frames": frames,
    }


if __name__ == "__main__":
    # Quick demo: a forest with a river, a westerly wind, ignition on the left.
    size = 40
    demo_map = [["forest" if (x + y) % 7 else "grass" for x in range(size)] for y in range(size)]
    for y in range(size):
        demo_map[y][25] = "water"
    result = simulate(demo_map, [(20, 5)], wind_direction=270, wind_speed=5,
                      humidity=30, seed=1)
    glyph = {UNBURNT: ".", BURNING: "#", BURNT: "x"}
    for i in (0, 10, 30, 100):
        print(f"frame {i}")
        print("\n".join("".join(glyph[s] for s in row) for row in result[i]))
