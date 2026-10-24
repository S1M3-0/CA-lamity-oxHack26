"""CLI for prepared hazard-grid ingestion.

Run from backend/: python -m api.ingest prepare --place oxford --hazard wildfire --dry-run
"""

import argparse
import json


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare and validate TerraShift source grids")
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("--place", required=True, choices=["fort-mcmurray", "oxford", "brisbane", "los-angeles"])
    prep.add_argument("--hazard", required=True, choices=["wildfire", "flood"])
    mode = prep.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--publish", action="store_true")
    args = parser.parse_args()

    from ingest.pipeline import prepare

    result = prepare(args.place, args.hazard, publish=args.publish)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
