"""POC: request authentication is disabled.

``require_bearer_token`` keeps a stable signature for callers but performs no
checks. Do not use this deployment pattern for production.
"""

from __future__ import annotations

from fastapi import Request


def require_bearer_token(
    request: Request,
    token: str | None,
    *,
    realm: str,
    env_var: str,
) -> None:
    """POC: no enforcement — signature preserved for call sites."""
    del request, token, realm, env_var
    return
