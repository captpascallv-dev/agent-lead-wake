"""Repository CLI entry for the ledger also bundled inside the installable plugin."""
from pathlib import Path
import runpy
import sys

if __name__ == "__main__":
    if sys.version_info < (3, 10):
        raise SystemExit("Python 3.10+ is required")
    runpy.run_path(str(Path(__file__).resolve().parents[1] / "plugin" / "driver" / "ledger.py"), run_name="__main__")
