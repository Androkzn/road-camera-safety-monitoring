"""services/ — backend business-logic package.

What it does:
    Marks this folder as a Python "package" so sibling files (digest,
    watchdog, registry, drift, llm, llm_obs, agents, test_runner, redact)
    can be imported as ``road_safety.services.<name>``. A package's
    ``__init__.py`` runs once the first time anything in the folder is
    imported — it is the entry point for the whole services layer.

Purpose:
    Groups the business-logic services used by the FastAPI app
    (``road_safety/server.py``): LLM calls, AI agents, vehicle registry,
    drift monitoring, background schedulers, PII redaction, the watchdog,
    and the pytest runner. Keeping them in one folder separates "what the
    system does" from "how it talks to HTTP clients".

Connects to:
    - Backend: imported by ``road_safety/server.py`` to wire every REST
      endpoint under ``/api/*``.
    - UI: none directly — each sibling module powers a specific endpoint
      or page (see their own docstrings).
"""
