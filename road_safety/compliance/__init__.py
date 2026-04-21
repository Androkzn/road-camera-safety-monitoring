"""compliance/__init__.py — package marker for compliance modules.

What it does:
    Marks the ``road_safety/compliance/`` folder as a Python package so
    other code can write ``from road_safety.compliance import audit`` or
    ``from road_safety.compliance.retention import run_sweep``. In Python,
    a folder becomes an importable package when it contains a file named
    ``__init__.py`` — even an almost-empty one like this.

Purpose:
    Groups the two legal/privacy-facing modules under a single namespace:
      * ``audit.py``     — append-only access log for GDPR Art. 30 / SOC 2.
      * ``retention.py`` — auto-delete of old thumbnails, feedback, queues.
    Both serve the dashcam product's "we can prove who saw what, and we
    don't keep personal data longer than we need" compliance story.

How it works:
    The triple-quoted string at the top of the file is a "module
    docstring" — documentation that Python attaches to the package itself.
    There is no executable code here; importing this package just makes
    the submodules reachable by name.

Connects to:
    - Backend: imported by ``road_safety/server.py`` to wire up the
      ``/api/audit``, ``/api/audit/stats``, and ``/api/retention/sweep``
      HTTP endpoints, and to start the hourly retention background task.
    - UI: none — backend-only. (Consumed indirectly by admin surfaces
      that hit those audit/retention endpoints.)
"""
