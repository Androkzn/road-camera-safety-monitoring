"""Network-level guards only.

This POC has no user accounts, no roles, and no request authentication.
The helpers that live in this package guard against *network-level* abuse,
not against unauthorised callers:

* :mod:`backend.security.ssrf` — reject operator-supplied stream URLs that
  resolve to private / loopback / cloud-metadata IPs.
* :mod:`backend.security.rate_limit` — throttle the expensive annotated
  clip render so a single caller cannot pin the CPU.

The cloud receiver (:mod:`cloud.receiver`) owns its own HMAC verification
for edge-to-cloud event ingest; that signing is message authentication,
not user authentication, and is unrelated to this package.
"""
