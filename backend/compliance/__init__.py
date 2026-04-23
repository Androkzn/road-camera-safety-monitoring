"""Audit log + retention policy + privacy hashing.

Everything that exists because legal / GDPR told us it had to. Holds
the append-only audit log ([audit.py](audit.py)), the hourly retention
sweep ([retention.py](retention.py)), and the ingest-time PII scrub
primitives ([privacy.py](privacy.py)) — most importantly
``hash_and_strip_plate``, which removes raw plate text before any
in-memory buffer ever sees it.

UI connection
-------------
Page: Admin / Monitoring pages
UI element: indirect; drives the audit trail surfaced to operators and
            enforces the retention guarantees shown in settings.
"""
