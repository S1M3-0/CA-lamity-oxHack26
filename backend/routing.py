"""Fastest safe road route for responders (fire stations, police, ambulances) to the
people the hazard reaches next.

The road network is OpenStreetMap ways, split into segments at junctions. Each
segment closes at the simulated hour the hazard first comes within one cell of it,
so a route never drives through fire or floodwater. Routing is a time-dependent
multi-source Dijkstra from every station: a segment can be used only if the crew
gets off it before it closes. Closures only ever grow, so the earliest arrival
at a node is still found by plain Dijkstra.

For each simulated hour the target is a street the hazard reaches within the next
LOOKAHEAD_H hours, preferring residential streets (where people are). Of those,
the route goes to the one with the least spare time that a crew can still reach
before the hazard does; if none can be reached in time, the one reached soonest
after it. When no street is about to be hit (a fire in roadless hills), the
route goes to the open road nearest the hazard's edge instead, to reach the
disaster itself.

Illustrative: speeds are typical emergency-driving guesses, and road closures come
from the simplified hazard models.
"""

import heapq
import math
from dataclasses import dataclass

import numpy as np

METRES_PER_DEG = 111_320.0
# km/h for each OSM highway class an emergency vehicle uses.
SPEED_KMH: dict[str, float] = {
    "motorway": 90, "motorway_link": 50, "trunk": 75, "trunk_link": 45,
    "primary": 60, "primary_link": 40, "secondary": 50, "secondary_link": 35,
    "tertiary": 45, "tertiary_link": 30, "unclassified": 35, "residential": 30,
    "living_street": 15, "track": 15,
}
# Classes where people live, so a threatened node on one is a potential victim.
RESIDENTIAL = {"residential", "living_street", "unclassified", "tertiary"}
ONEWAY_BY_DEFAULT = {"motorway", "motorway_link"}
SAMPLE_M = 15.0          # spacing of the points checked against the hazard along each segment
LOOKAHEAD_H = 2.0        # how far ahead of the front to look for people to reach
MAX_TRAVEL_S = 2 * 3600  # stop searching beyond a two-hour drive
SNAP_M = 1000.0          # a station further than this from any road isn't used
FRONT_CELLS = 30         # how many cells out from the hazard's edge to look for an open road
NEVER = np.inf


@dataclass(frozen=True)
class Station:
    name: str
    kind: str
    lon: float
    lat: float


@dataclass
class RoadGraph:
    lon: np.ndarray                 # per node
    lat: np.ndarray
    residential: np.ndarray         # per node: on a residential street
    adj: list[list[tuple[int, float, int]]]  # per node: (next node, seconds, segment)
    seg_coords: list[np.ndarray]    # per segment: (n, 2) lon/lat polyline, from its first node
    seg_start: np.ndarray           # per segment: node at the start of seg_coords
    seg_len: np.ndarray             # per segment: metres
    samples: np.ndarray             # (k, 2) lon/lat points along every segment
    sample_seg: np.ndarray          # segment of each sample
    stations: list[tuple[Station, int]]  # stations snapped to their nearest node


def _metres(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Length of each step of a lon/lat polyline (equirectangular, fine at city scale)."""
    mid = np.radians((lat[1:] + lat[:-1]) / 2)
    dx = np.diff(lon) * METRES_PER_DEG * np.cos(mid)
    dy = np.diff(lat) * METRES_PER_DEG
    return np.hypot(dx, dy)


def _oneway(tags: dict) -> int:
    """1 forward only, -1 backward only, 0 both ways."""
    value = tags.get("oneway", "")
    if value in ("yes", "true", "1"):
        return 1
    if value == "-1":
        return -1
    if value == "no":
        return 0
    return 1 if tags.get("highway") in ONEWAY_BY_DEFAULT or tags.get("junction") == "roundabout" else 0


def build_graph(ways: list[dict], stations: list[Station]) -> RoadGraph:
    """Junction-to-junction road graph from Overpass ways (`out body geom`)."""
    ways = [w for w in ways if w.get("tags", {}).get("highway") in SPEED_KMH
            and len(w.get("nodes", ())) >= 2 and len(w.get("geometry", ())) == len(w["nodes"])]
    uses: dict[int, int] = {}
    for w in ways:
        for k, osm in enumerate(w["nodes"]):
            # Endpoints count twice so every way starts and ends on a junction.
            uses[osm] = uses.get(osm, 0) + (2 if k in (0, len(w["nodes"]) - 1) else 1)

    index: dict[int, int] = {}
    lons: list[float] = []
    lats: list[float] = []
    residential: list[bool] = []

    def node(osm: int, lon: float, lat: float, res: bool) -> int:
        i = index.get(osm)
        if i is None:
            i = index[osm] = len(lons)
            lons.append(lon)
            lats.append(lat)
            residential.append(res)
        elif res:
            residential[i] = True
        return i

    adj: list[list[tuple[int, float, int]]] = []
    seg_coords: list[np.ndarray] = []
    seg_start: list[int] = []
    seg_len: list[float] = []
    for w in ways:
        tags = w["tags"]
        speed = SPEED_KMH[tags["highway"]] / 3.6
        res = tags["highway"] in RESIDENTIAL
        direction = _oneway(tags)
        coords = np.array([[g["lon"], g["lat"]] for g in w["geometry"]])
        cut = [k for k, osm in enumerate(w["nodes"]) if uses[osm] > 1]
        for a, b in zip(cut, cut[1:]):
            part = coords[a:b + 1]
            length = float(_metres(part[:, 0], part[:, 1]).sum())
            u = node(w["nodes"][a], *part[0], res)
            v = node(w["nodes"][b], *part[-1], res)
            if u == v:
                continue
            while len(adj) < len(lons):
                adj.append([])
            s, secs = len(seg_coords), length / speed
            seg_coords.append(part)
            seg_start.append(u)
            seg_len.append(length)
            if direction >= 0:
                adj[u].append((v, secs, s))
            if direction <= 0:
                adj[v].append((u, secs, s))
    while len(adj) < len(lons):
        adj.append([])

    # Points every SAMPLE_M along each segment, which are checked against the hazard grid.
    samples, sample_seg = [], []
    for s, part in enumerate(seg_coords):
        steps = _metres(part[:, 0], part[:, 1])
        for k, step in enumerate(steps):
            n = max(1, math.ceil(step / SAMPLE_M))
            f = np.arange(n + (k == len(steps) - 1)) / n
            samples.append(part[k] + (part[k + 1] - part[k]) * f[:, None])
            sample_seg.append(np.full(f.size, s))

    lon, lat = np.array(lons), np.array(lats)
    snapped = []
    if lon.size:
        for st in stations:
            d = np.hypot((lon - st.lon) * math.cos(math.radians(st.lat)), lat - st.lat) * METRES_PER_DEG
            i = int(np.argmin(d))
            if d[i] <= SNAP_M:
                snapped.append((st, i))
    return RoadGraph(
        lon=lon, lat=lat, residential=np.array(residential, dtype=bool), adj=adj,
        seg_coords=seg_coords, seg_start=np.array(seg_start, dtype=np.int64), seg_len=np.array(seg_len),
        samples=np.concatenate(samples) if samples else np.zeros((0, 2)),
        sample_seg=np.concatenate(sample_seg) if sample_seg else np.zeros(0, dtype=np.int64),
        stations=snapped,
    )


def _cells(bounds: tuple[float, float, float, float], shape: tuple[int, int],
           lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Flat cell index of each point, -1 outside the grid (row 0 is north)."""
    west, south, east, north = bounds
    rows, cols = shape
    c = np.floor((lon - west) / (east - west) * cols).astype(np.int64)
    r = np.floor((north - lat) / (north - south) * rows).astype(np.int64)
    inside = (r >= 0) & (r < rows) & (c >= 0) & (c < cols)
    return np.where(inside, r * cols + c, -1)


def _dilate_min(a: np.ndarray) -> np.ndarray:
    """Each cell takes the earliest arrival in its 3x3 neighbourhood."""
    padded = np.pad(a, 1, constant_values=NEVER)
    rows, cols = a.shape
    return np.minimum.reduce([padded[1 + dr:1 + dr + rows, 1 + dc:1 + dc + cols]
                              for dr in (-1, 0, 1) for dc in (-1, 0, 1)])


def _rings(affected: np.ndarray) -> np.ndarray:
    """Cells (8-connected steps) from each cell to the affected area, FRONT_CELLS + 1 if further."""
    ring = np.where(affected, 0, FRONT_CELLS + 1)
    reached = affected
    for k in range(1, FRONT_CELLS + 1):
        grown = _dilate_min(np.where(reached, 0.0, NEVER)) == 0
        new = grown & ~reached
        if not new.any():
            break
        ring[new] = k
        reached = grown
    return ring


def _closures(g: RoadGraph, bounds, arrival: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Hour each segment closes and hour the hazard reaches each node (NEVER if it doesn't)."""
    near = _dilate_min(arrival).ravel()
    cells = _cells(bounds, arrival.shape, g.samples[:, 0], g.samples[:, 1])
    at = np.where(cells >= 0, near[np.maximum(cells, 0)], NEVER)
    seg_close = np.full(len(g.seg_coords), NEVER)
    np.minimum.at(seg_close, g.sample_seg, at)
    node_cells = _cells(bounds, arrival.shape, g.lon, g.lat)
    node_eta = np.where(node_cells >= 0, arrival.ravel()[np.maximum(node_cells, 0)], NEVER)
    return seg_close, node_eta


def _dijkstra(g: RoadGraph, hour: float, seg_close: list[float], node_eta: np.ndarray):
    """Earliest drive time (s) from any open station to every node, leaving at `hour`."""
    n = len(g.adj)
    best = [math.inf] * n
    prev: list[tuple[int, int] | None] = [None] * n  # (previous node, segment)
    origin = [-1] * n                                  # station index each node is reached from
    heap = []
    for k, (_, i) in enumerate(g.stations):
        if node_eta[i] > hour and best[i] > 0:
            best[i], origin[i] = 0.0, k
            heap.append((0.0, i))
    heapq.heapify(heap)
    while heap:
        t, u = heapq.heappop(heap)
        if t > best[u]:
            continue
        if t > MAX_TRAVEL_S:
            break
        for v, secs, s in g.adj[u]:
            arrive = t + secs
            if arrive < best[v] and hour + arrive / 3600 < seg_close[s]:
                best[v], prev[v], origin[v] = arrive, (u, s), origin[u]
                heapq.heappush(heap, (arrive, v))
    return np.array(best), prev, origin


def _path(g: RoadGraph, prev, target: int) -> tuple[list[list[float]], float]:
    """Polyline from the station to `target` and its length in metres."""
    parts, length, v = [], 0.0, target
    while prev[v] is not None:
        u, s = prev[v]
        coords = g.seg_coords[s]
        parts.append(coords if g.seg_start[s] == u else coords[::-1])
        length += g.seg_len[s]
        v = u
    if not parts:
        return [[float(g.lon[target]), float(g.lat[target])]], 0.0
    line = np.concatenate([p if k == 0 else p[1:] for k, p in enumerate(reversed(parts))])
    return np.round(line, 6).tolist(), length


def plan_routes(g: RoadGraph, bounds: tuple[float, float, float, float], arrival: np.ndarray,
                hours: list[float]) -> list[dict]:
    """One route per hour that has someone to reach. `arrival` is hours until each cell
    is first affected (NEVER if it isn't), row 0 north, over `bounds`."""
    if not g.stations or not g.adj:
        return []
    seg_close, node_eta = _closures(g, bounds, arrival)
    seg_close_list = seg_close.tolist()
    node_cells = _cells(bounds, arrival.shape, g.lon, g.lat)
    routes = []
    for hour in hours:
        affected = arrival <= hour
        if not affected.any():
            continue
        best, prev, origin = _dijkstra(g, hour, seg_close_list, node_eta)
        soon = (node_eta > hour) & (node_eta <= hour + LOOKAHEAD_H) & np.isfinite(best)
        targets = np.flatnonzero(soon & g.residential)
        if not targets.size:
            targets = np.flatnonzero(soon)

        if targets.size:
            goal = "people"
            reach = best[targets]
            spare_h = node_eta[targets] - hour - reach / 3600
            in_time = spare_h > 0
            # Most urgent street a crew still beats the hazard to; else the one reached soonest after it.
            pick = int(np.argmin(np.where(in_time, spare_h, np.inf)) if in_time.any() else np.argmax(spare_h))
            target, spare_s = int(targets[pick]), float(spare_h[pick] * 3600)
        else:
            # Nobody in the path: reach the hazard's edge on the nearest open road, soonest first.
            ring = np.where(node_cells >= 0, _rings(affected).ravel()[np.maximum(node_cells, 0)], FRONT_CELLS + 1)
            near = np.flatnonzero((ring <= FRONT_CELLS) & (node_eta > hour) & np.isfinite(best))
            if not near.size:
                continue
            goal = "front"
            target, spare_s = int(near[np.lexsort((best[near], ring[near]))[0]]), None

        station = g.stations[origin[target]][0]
        path, length = _path(g, prev, target)
        eta = node_eta[target]
        routes.append({
            "hour": hour,
            "goal": goal,
            "station": {"name": station.name, "kind": station.kind, "lon": station.lon, "lat": station.lat},
            "target": {"lon": float(g.lon[target]), "lat": float(g.lat[target]),
                       "hazard_eta_h": float(eta) if np.isfinite(eta) else None,
                       "residential": bool(g.residential[target])},
            "travel_s": float(best[target]),
            "distance_m": float(length),
            "spare_s": spare_s,
            "path": path,
        })
    return routes
