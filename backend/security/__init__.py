"""Request-side guards: SSRF check + per-IP rate limit.

Network-level defence only — this POC has no user accounts, roles, or
request authentication. [ssrf.py](ssrf.py) rejects operator-supplied
stream URLs that resolve to private / loopback / cloud-metadata IPs;
[rate_limit.py](rate_limit.py) throttles the expensive annotated clip
render so a single caller cannot pin the CPU. The cloud receiver's
HMAC verification is message-level and lives elsewhere
(``cloud.receiver``).

UI connection
-------------
Page: Sources page (URL submission), Events page (clip render)
UI element: indirect; blocks a submitted stream URL before it is
            accepted, and throttles clip-render requests.
"""
