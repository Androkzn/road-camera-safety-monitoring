"""__init__.py — marks `road_safety/` as a Python package.

What it does:
    Declares the `road_safety` folder as an importable Python package and
    advertises its version number. In Python, any folder containing an
    `__init__.py` file becomes a "package" that other code can import from
    (e.g. `from road_safety.config import ...`).

Purpose:
    Gives the backend a single named namespace — every module in the
    project lives under `road_safety.*`. The `__version__` string is the
    one place to bump the app version for release tagging and diagnostics.

How it works:
    Python automatically runs this file the first time anything imports
    from the package. Right now it only sets `__version__`; it does NOT
    auto-load submodules, so importing `road_safety` by itself is cheap.

Connects to:
    - Backend: every other file in `road_safety/` belongs to this package.
    - UI: none — backend-only.
"""

__version__ = "1.0.0"
