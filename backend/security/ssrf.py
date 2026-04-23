"""SSRF guard for operator-supplied stream URLs.

``validate_public_url`` rejects URLs that resolve to a private / loopback /
link-local / multicast / cloud-metadata IP, so a caller
still can't point the edge node at internal services like the AWS IMDS
(``http://169.254.169.254/``). Implements BE-D15 from the 2026-04-20 backend
audit.

Extracted from ``server.py`` as part of the refactor plan, step 2. Behaviour
unchanged — only the location.

UI connection
-------------
Page: SettingsPage / AdminPage
UI element: No direct UI — rejects bad URLs submitted through the
       source-add controls on the SettingsPage and the AdminPage source-add
       form before any stream slot is created.
"""

import ipaddress
import socket
from urllib.parse import urlparse

from fastapi import HTTPException

from backend.logging import get_logger

log = get_logger(__name__)


# Known-public CDN hostnames bypass the ``getaddrinfo``-based SSRF check.
# These are the documented yt-dlp happy paths and carry no plausible
# internal-service impersonation risk; skipping DNS resolution here keeps
# ``POST /api/live/sources`` snappy for the dominant operator workflow.
SSRF_ALLOWLIST_SUFFIXES: tuple[str, ...] = (
    ".youtube.com",
    "youtube.com",
    "youtu.be",
    ".googlevideo.com",
)


def validate_public_url(url: str) -> None:
    """Reject URLs that resolve to a private / loopback / cloud-metadata IP.

    Implements BE-D15 from the 2026-04-20 backend audit. Applied to
    ``POST /api/live/sources`` before the slot is created so an operator (or
    attacker on the same network) can't paste ``http://169.254.169.254/...``
    (AWS IMDS) or any RFC1918 address the edge node might reach.

    Args:
        url: The user-supplied stream URL (already passed the scheme check).

    Raises:
        HTTPException: 400 when the URL has no hostname, fails DNS, or any
            resolved address falls inside a disallowed range.

    Caveats:
        * DNS rebinding is not fully mitigated here — yt-dlp / OpenCV will
          re-resolve at dial time. A future hardening would dial the
          resolved IP directly. Out of scope for BE-D15.
        * The YouTube / googlevideo allowlist intentionally skips DNS
          resolution (these are known-public CDNs and the primary happy
          path for yt-dlp). Adding a host there is a conscious trust
          decision.
    """
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").strip().lower()
    if not hostname:
        raise HTTPException(400, "url has no hostname")

    # Allowlist bypass for the well-known public CDNs.
    if hostname == "youtu.be" or any(
        hostname.endswith(sfx) for sfx in SSRF_ALLOWLIST_SUFFIXES
    ):
        return

    # If the host is already a literal IP, validate it directly — skip DNS.
    # ``ipaddress.ip_address`` accepts both IPv4 and IPv6 literal forms and
    # raises ``ValueError`` for anything that is not a bare IP literal.
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None

    addresses: list[str] = []
    if literal is not None:
        addresses.append(str(literal))
    else:
        # ``getaddrinfo(host, None)`` returns every A / AAAA record the OS
        # resolver can see. We must check ALL of them — a hostile DNS entry
        # could round-robin a public IP with an internal one (so picking
        # just the first record is insufficient to defeat a motivated SSRF).
        try:
            infos = socket.getaddrinfo(hostname, None)
        except socket.gaierror as exc:
            log.info("ssrf_check hostname resolve failed: %s (%s)", hostname, exc)
            raise HTTPException(400, "url hostname failed to resolve")
        for info in infos:
            # ``info`` is a 5-tuple ``(family, type, proto, canonname, sockaddr)``.
            # ``sockaddr`` is ``(host, port)`` for v4 and ``(host, port, flowinfo, scopeid)``
            # for v6 — in both cases index 0 is the resolved IP string.
            sockaddr = info[4]
            if not sockaddr:
                continue
            ip_str = str(sockaddr[0])
            if ip_str and ip_str not in addresses:
                addresses.append(ip_str)

    if not addresses:
        raise HTTPException(400, "url hostname failed to resolve")

    # Reject if ANY resolved address lands in a sensitive range — we never
    # want to partially trust a hostname that resolves to both public and
    # internal space.
    for addr in addresses:
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            # ``getaddrinfo`` should only ever return valid IP strings; if it
            # ever returns something unparseable, fail closed rather than
            # silently skipping the check.
            raise HTTPException(400, "url resolves to a disallowed address range")
        # Disallow every RFC-defined "not a random public host" category:
        #   is_private      — RFC1918 (10/8, 172.16/12, 192.168/16) plus v6 fc00::/7
        #   is_loopback     — 127.0.0.0/8, ::1
        #   is_link_local   — 169.254/16 (includes AWS/GCE IMDS at 169.254.169.254)
        #   is_multicast    — 224.0.0.0/4, ff00::/8
        #   is_reserved     — IANA-reserved / future use
        #   is_unspecified  — 0.0.0.0, ::
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            log.info(
                "ssrf_check rejected host=%s ip=%s kind=%s",
                hostname,
                addr,
                "private/loopback/link-local/multicast/reserved/unspecified",
            )
            raise HTTPException(
                400, "url resolves to a disallowed address range",
            )
