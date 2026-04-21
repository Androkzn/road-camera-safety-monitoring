"""__init__.py — marks `road_safety/core/` as an importable sub-package.

What it does:
    Declares the `core/` folder as a Python sub-package so other modules
    can write `from road_safety.core.detection import ...`. Any folder
    with an `__init__.py` file becomes a package in Python's import
    system.

Purpose:
    Groups the perception pipeline (object detection, stream capture,
    ego-motion, scene context, quality monitoring) under one namespace.
    These are the pieces that turn raw camera pixels into the typed
    safety events the rest of the app reasons about.

How it works:
    The file is intentionally almost empty — it does not re-export
    symbols. Each core submodule is imported explicitly by its
    consumers (e.g. `server.py`), keeping import cost low.

Connects to:
    - Backend: parent to `detection.py`, `stream.py`, `context.py`,
      `quality.py`, `egomotion.py`. Imported by `road_safety/server.py`
      and by batch tools under `tools/`.
    - UI: none — backend-only.
"""
