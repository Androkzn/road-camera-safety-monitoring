"""Edge-node perception server package.

Runs on-site at the fixed-camera install: ingests video, detects
conflicts, serves the operator UI, and publishes events to the cloud.
This file is the top-level marker for the ``backend`` Python package and
exposes the ``__version__`` string used by the ``/api/live/status``
health endpoint.

Role in the settings contract
-----------------------------
This package hosts the Settings Console primitives that back
``/api/settings`` (see :mod:`backend.settings_spec` for the schema and
:mod:`backend.settings_store` for the runtime snapshot). Every other
sub-package (``core/``, ``perception/``, ``services/``) reads tunables
through those two modules, never by re-importing raw constants from
``backend.config``.

Consumers
---------
* FE — every page of the React SPA hits routes mounted under this package.
  The Settings page reads ``schema_payload()`` and writes via
  ``STORE.apply_diff()`` indirectly through ``/api/settings/apply``.
* Perception pipeline — ``backend.core.*`` and ``backend.perception.*``
  call ``STORE.snapshot()`` per frame to read current tunables.
* Ops — ``/api/live/status`` surfaces ``__version__`` so the frontend
  can detect a server upgrade and prompt for a reload.

UI connection
-------------
Page: ALL pages
UI element: indirect; this package is the entire edge-server backend
            that every page of the SPA talks to.
"""

# ``__version__`` is a Python community convention (see PEP 396). It is a
# plain string so it can be read by tooling without importing side effects.
# Bump on user-visible changes; the frontend pins against this via the health
# endpoint (GET /api/live/status -> {version: __version__}).
__version__ = "1.0.0"
