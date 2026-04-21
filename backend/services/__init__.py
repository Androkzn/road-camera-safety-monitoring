"""Stateful background services surrounding the perception hot path.

Holds everything that is *not* on the frame-by-frame critical path:
LLM egress (``llm``), LLM observability (``llm_obs``), drift
monitoring (``drift``), the watchdog incident queue (``watchdog``),
impact engine (``impact``), ops sampler, settings DB, agents, digest,
PII redaction (``redact``), the vehicle registry, the test runner, and
prompt templates. Invariants: every LLM call routes through
``services.llm``; raw plate text is scrubbed at ingest; only
``_public`` thumbnails leave the host.

UI connection
-------------
Page: ALL pages (LLM narration, watchdog, drift, digests, registry)
UI element: indirect; enrichment, observability, and operational
            state backing every page of the SPA.
"""
