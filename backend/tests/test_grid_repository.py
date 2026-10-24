"""Repository format and configuration checks that do not need a live DB."""

import gzip
import json
import os
import struct
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from api.grid_repository import GridIntegrityError, _metadata, _validate_prepared_blob
from api.routes.places import places


class GridRepositoryTests(unittest.TestCase):
    def test_prepared_blob_requires_complete_finite_arrays(self):
        n = 4
        raw = b"TSGRID1\n" + struct.pack("<4f", 1, 2, 3, 4)
        raw += struct.pack("<4f", 0.2, 0.3, 0, 0.8)
        raw += bytes([1] * n) + bytes([0, 0, 1, 0])
        raw += bytes([1, 1, 0, 1]) + bytes([0, 0, 0, 1])
        _validate_prepared_blob(gzip.compress(raw, mtime=0), 2, 2)
        with self.assertRaises(GridIntegrityError):
            _validate_prepared_blob(gzip.compress(raw[:-1], mtime=0), 2, 2)
        with self.assertRaises(GridIntegrityError):
            _validate_prepared_blob(gzip.compress(raw.replace(struct.pack("<f", 3), struct.pack("<f", float("nan")), 1), mtime=0), 2, 2)

    def test_metadata_is_json_serializable_and_dates_are_list(self):
        row = {
            "id": "00000000-0000-0000-0000-000000000001",
            "version": "v1", "place_slug": "oxford", "hazard": "wildfire",
            "metric_crs": 32630, "affine": [0, 60, 0, 12000, 0, -60],
            "width": 200, "height": 200, "cell_size_m": 60,
            "footprint_json": json.dumps({"type": "Polygon", "coordinates": [[[0,1],[1,1],[1,0],[0,0],[0,1]]]}),
            "source_dates": {"acquisitions": ["2026-10-01"]},
            "processing_version": "p1", "model_version": "ts-model-2", "quality": {},
        }
        metadata = _metadata(row)
        self.assertEqual(json.loads(json.dumps(metadata))["sourceDates"], ["2026-10-01"])
        self.assertEqual(metadata["displayCorners"][0], [0.0, 1.0])
        self.assertNotIn("arrays", metadata)

    def test_missing_database_is_clear_503(self):
        with patch.dict(os.environ, {"DATABASE_URL": ""}):
            with self.assertRaises(HTTPException) as caught:
                places()
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("DATABASE_URL", caught.exception.detail)


if __name__ == "__main__":
    unittest.main()
