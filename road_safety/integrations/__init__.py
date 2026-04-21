"""integrations/__init__.py — package marker for external-service connectors.

What it does:
    Marks ``road_safety/integrations/`` as a Python package so callers can
    write imports like ``from road_safety.integrations import slack`` or
    ``from road_safety.integrations.edge_publisher import EdgePublisher``.
    The file itself holds no logic — it just tells Python "this folder is
    an importable module namespace".

Purpose:
    Groups every outbound connector the dashcam backend talks to:
      * ``slack.py``          — Incoming Webhook alerts + hourly digests.
      * ``edge_publisher.py`` — signed JSONL batch upload to a cloud receiver.
      * ``fnol.py``           — shapes events into an insurer-friendly
                                First Notice of Loss record (no transport yet).
    Keeping these together makes it obvious what leaves the edge device.

How it works:
    Python treats any folder with an ``__init__.py`` as a package. The
    triple-quoted string is the package's docstring — descriptive text
    attached to the package object, readable via ``help(...)`` or IDEs.

Connects to:
    - Backend: ``road_safety/server.py`` imports ``slack.notify_event`` and
      ``edge_publisher.EdgePublisher``; ``services/digest.py`` imports the
      slack digest helpers; ``fnol`` is currently library-only (no route).
    - UI: none — backend-only. (Slack alerts appear in the customer's Slack
      workspace, not in the web dashboard.)
"""
