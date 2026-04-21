"""tests package — pytest collects every test_*.py file under this directory.

What it does:
    Marks `tests/` as an importable Python package. The file itself stays
    empty of code so pytest's test discovery handles everything.

Purpose:
    Required so relative imports (and shared fixtures in conftest.py) work
    predictably across the test modules.

How it works:
    Python treats any directory containing an `__init__.py` as a package.
    pytest then walks the package, imports every `test_*.py`, and collects
    classes/functions named `Test*` / `test_*` as test cases.

Connects to:
    - Backend: none directly — tests import `road_safety.*` modules.
    - UI: none — test file.
"""
