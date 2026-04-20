"""SSRF guard for operator-supplied stream URLs.

``validate_public_url`` rejects URLs that resolve to a private / loopback /
link-local / multicast / cloud-metadata IP, so a caller with the admin token
still can't point the edge node at internal services like the AWS IMDS
(``http://169.254.169.254/``). Implements BE-D15 from the 2026-04-20 backend
audit.

Extracted from ``server.py`` as part of the refactor plan, step 2. Behaviour
unchanged — only the location.
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
    attacker with the admin token) can't paste ``http://169.254.169.254/...``
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
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None

    addresses: list[str] = []
    if literal is not None:
        addresses.append(str(literal))
    else:
        try:
            infos = socket.getaddrinfo(hostname, None)
        except socket.gaierror as exc:
            log.info("ssrf_check hostname resolve failed: %s (%s)", hostname, exc)
            raise HTTPException(400, "url hostname failed to resolve")
        for info in infos:
            sockaddr = info[4]
            if not sockaddr:
                continue
            ip_str = sockaddr[0]
            if ip_str and ip_str not in addresses:
                addresses.append(ip_str)

    if not addresses:
        raise HTTPException(400, "url hostname failed to resolve")

    for addr in addresses:
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            raise HTTPException(400, "url resolves to a disallowed address range")
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
