"""Edge-node perception server package.

Runs on-site at the fixed-camera install: ingests video, detects
conflicts, serves the operator UI, and publishes events to the cloud.
This file is the top-level marker for the ``backend`` Python package and
exposes the ``__version__`` string used by the ``/api/live/status``
health endpoint.

UI connection
-------------
Page: ALL pages
UI element: indirect; this package is the entire edge-server backend
            that every page of the SPA talks to.
"""

# ``__version__`` is a Python community convention (see PEP 396). It is a
# plain string so it can be read by tooling without importing side effects.
# Bump on user-visible changes; the frontend pins against this via the health
# endpoint.
__version__ = "1.0.0"
