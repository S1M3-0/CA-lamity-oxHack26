import threading
import unittest
from unittest.mock import patch

import numpy as np

import routing

# A 10x10 grid over 0.01° squares near the equator (~111 m cells).
BOUNDS = (0.0, 0.0, 0.1, 0.1)
CELL = 0.01


def way(osm_ids, coords, highway="residential", **tags):
    return {"type": "way", "nodes": osm_ids, "geometry": [{"lon": x, "lat": y} for x, y in coords],
            "tags": {"highway": highway, **tags}}


def centre(col, row):
    """Lon/lat of a cell's centre (row 0 north)."""
    return (col + 0.5) * CELL, 0.1 - (row + 0.5) * CELL


def arrival_grid(cells: dict[tuple[int, int], float]) -> np.ndarray:
    a = np.full((10, 10), routing.NEVER)
    for (row, col), hour in cells.items():
        a[row, col] = hour
    return a


class RoutingTests(unittest.TestCase):
    def setUp(self):
        # Station at the west end of row 5; two roads east to a junction at column 8:
        # a direct one along row 5 and a detour north along row 1.
        p = {k: centre(*k) for k in [(0, 5), (4, 5), (8, 5), (0, 1), (8, 1)]}
        self.ways = [
            way([1, 2, 3], [p[(0, 5)], p[(4, 5)], p[(8, 5)]], "primary"),
            way([1, 4], [p[(0, 5)], p[(0, 1)]], "primary"),
            way([4, 5], [p[(0, 1)], p[(8, 1)]], "primary"),
            way([5, 3], [p[(8, 1)], p[(8, 5)]], "primary"),
            way([3, 6], [p[(8, 5)], centre(9, 5)]),
        ]
        self.station = routing.Station("Station 1", "fire_station", *p[(0, 5)])
        self.graph = routing.build_graph(self.ways, [self.station])

    def test_graph_keeps_junctions_only(self):
        # Node 2 sits mid-way with no other road on it, so it isn't a graph node.
        self.assertEqual(len(self.graph.adj), 5)
        self.assertEqual(len(self.graph.stations), 1)

    def test_route_reaches_threatened_street_before_the_hazard(self):
        arrival = arrival_grid({(5, 9): 1.5, (0, 9): 0.0})
        routes = routing.plan_routes(self.graph, BOUNDS, arrival, [0.0])
        self.assertEqual(len(routes), 1)
        r = routes[0]
        self.assertEqual(r["goal"], "people")
        self.assertEqual(r["station"]["name"], "Station 1")
        self.assertAlmostEqual(r["target"]["hazard_eta_h"], 1.5)
        self.assertGreater(r["spare_s"], 0)
        self.assertAlmostEqual(r["path"][0][0], self.station.lon)
        # The direct road along row 5 is open, so the route stays on it.
        self.assertTrue(all(abs(lat - centre(0, 5)[1]) < 1e-9 for _, lat in r["path"]))

    def test_route_detours_round_a_burnt_road(self):
        # Hazard sits on the direct road from the start; the target further east burns later.
        arrival = arrival_grid({(5, 4): 0.0, (5, 9): 1.5})
        r = routing.plan_routes(self.graph, BOUNDS, arrival, [0.0])[0]
        lats = {round(lat, 6) for _, lat in r["path"]}
        self.assertIn(round(centre(0, 1)[1], 6), lats)  # went round by the northern road
        cells = routing._cells(BOUNDS, (10, 10), np.array([x for x, _ in r["path"]]), np.array([y for _, y in r["path"]]))
        self.assertNotIn(5 * 10 + 4, cells.tolist())

    def test_front_when_nobody_is_in_the_path(self):
        # Fire in the empty middle of the map, never reaching a road.
        arrival = arrival_grid({(3, 4): 0.0})
        r = routing.plan_routes(self.graph, BOUNDS, arrival, [0.0])[0]
        self.assertEqual(r["goal"], "front")
        self.assertIsNone(r["spare_s"])
        self.assertIsNone(r["target"]["hazard_eta_h"])

    def test_no_route_before_the_hazard_starts(self):
        arrival = arrival_grid({(5, 9): 3.0})
        self.assertEqual(routing.plan_routes(self.graph, BOUNDS, arrival, [0.0]), [])

    def test_oneway_is_respected(self):
        # Only a one-way road pointing back towards the station: the threatened end can't be reached.
        a, b = centre(0, 5), centre(8, 5)
        g = routing.build_graph([way([1, 2], [b, a], "primary", oneway="yes")], [self.station])
        arrival = arrival_grid({(5, 8): 1.0, (0, 0): 0.0})
        routes = routing.plan_routes(g, BOUNDS, arrival, [0.0])
        self.assertTrue(all(r["goal"] == "front" and r["distance_m"] == 0 for r in routes))


class RoadDownloadTests(unittest.TestCase):
    """The endpoint answers "preparing" while an area's roads download, instead of outlasting the proxy."""

    def setUp(self):
        from api.routes import responders
        self.r = responders
        responders._loading.clear()

    def test_slow_download_is_pending_then_ready(self):
        release = threading.Event()
        with patch.object(self.r, "_graph", side_effect=lambda area: release.wait(5) and "graph"):
            self.assertIsNone(self.r._ready_graph((1, 2, 3, 4), wait_s=0.05))
            self.assertIsNone(self.r._ready_graph((1, 2, 3, 4), wait_s=0.05))  # same download, not a second one
            self.assertEqual(self.r._graph.call_count, 1)
            release.set()
            self.assertEqual(self.r._ready_graph((1, 2, 3, 4), wait_s=5), "graph")

    def test_socket_timeout_fails_once_then_retries(self):
        # A TimeoutError raised inside the download must not look like "still downloading".
        with patch.object(self.r, "_graph", side_effect=TimeoutError("timed out")):
            with self.assertRaises(TimeoutError):
                self.r._ready_graph((5, 6, 7, 8), wait_s=5)
            with self.assertRaises(TimeoutError):
                self.r._ready_graph((5, 6, 7, 8), wait_s=5)
            self.assertEqual(self.r._graph.call_count, 2)


if __name__ == "__main__":
    unittest.main()
