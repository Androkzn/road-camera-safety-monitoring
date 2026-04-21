"""slack.py — tiered Slack notifications for road-safety events.

What it does:
    Sends formatted messages to a customer's Slack workspace via an
    Incoming Webhook URL. High-risk events fire an immediate, rich
    "Block Kit" card with narration, kinematics, and optional image.
    Medium-risk events are collected in memory and posted as one
    hourly digest. Low-risk events are collected for a daily digest.
    A quality gate blocks high-risk alerts that lack sustained
    evidence so fleet managers aren't paged on single noisy frames.

Purpose:
    Customers want Slack because that's where their operations team
    already lives — they don't want yet another dashboard tab to watch.
    Tiering exists because a fleet with dozens of trucks would otherwise
    drown in notifications; only genuine near-misses deserve an instant
    ping, everything else is context for periodic review.

How it works:
    Three tiers, three entry points:
      * ``notify_high(event, thumb_path)`` — posts immediately.
      * ``buffer_medium(event)`` / ``buffer_low(event)`` — append to
        module-level lists ``_MEDIUM_BUFFER`` / ``_LOW_BUFFER``.
      * ``flush_medium_digest()`` / ``flush_low_daily()`` — drain the
        buffers and post one combined message. These are called on a
        schedule by ``road_safety/services/digest.py``.

    ``notify_event(event, thumb_path)`` is the public dispatcher used
    by ``server.py``. For high-risk events it runs ``_passes_high_quality_gate``
    first: the event must have at least ``SLACK_HIGH_MIN_DURATION_SEC``
    of sustained episode, at least ``SLACK_HIGH_MIN_FRAMES`` high-risk
    frames, and confidence at least ``SLACK_HIGH_MIN_CONFIDENCE``.
    Events that fail are *downgraded* to the medium buffer rather than
    silently dropped — nothing is lost.

    ``async def`` on the posting functions means they can ``await``
    an HTTP response (via ``httpx.AsyncClient``) without blocking the
    main server loop. Image relay is opt-in via ``SLACK_ENABLE_IMAGE_RELAY``:
    when off, high-risk cards are text-only so redacted thumbnails are
    never published to a third-party host. Plate data on the egress
    payload is always a salted SHA-256 hash, never the raw plate text.

Configuration (environment variables):
    SLACK_WEBHOOK_URL              required — https://hooks.slack.com/...
    SLACK_MIN_RISK                 "high" | "medium" | "low"  (default "high")
    SLACK_ENABLE_IMAGE_RELAY       "1" to publish thumbnails (default off)
    SLACK_HIGH_MIN_DURATION_SEC    gate: episode duration (default 1.5)
    SLACK_HIGH_MIN_FRAMES          gate: high-risk frames  (default 2)
    SLACK_HIGH_MIN_CONFIDENCE      gate: detector confidence (default 0.55)

Caveats:
    Medium/low buffers are in-memory — they reset on process restart.
    Deployments expecting long Slack outages should swap them for a
    persistent store with a memory cap.

Connects to:
    - Backend: ``road_safety/server.py`` imports ``notify_event`` and
      ``slack_configured``; ``road_safety/services/digest.py`` drives
      the hourly/daily flush schedule; ``road_safety/api/feedback.py``
      reads ``get_medium_buffer()`` so the operator coaching queue can
      show the same events Slack would have digested.
    - UI: indirectly — the web dashboard consumes
      ``GET /api/coaching_queue`` (backed by ``get_medium_buffer()``)
      to populate the operator-review list. Slack messages themselves
      appear in the customer's Slack workspace, not the web UI.
"""

from __future__ import annotations

import os
from collections import Counter
from pathlib import Path

import httpx

_WEBHOOK = os.getenv("SLACK_WEBHOOK_URL")
_MIN_RISK = os.getenv("SLACK_MIN_RISK", "high").lower()

_RISK_ORDER = {"low": 1, "medium": 2, "high": 3}
_RISK_EMOJI = {"high": ":rotating_light:", "medium": ":warning:", "low": ":information_source:"}
_SLA = {"high": "15 minutes", "medium": "24 hours", "low": "weekly batch"}

_IMAGE_HOST = "https://catbox.moe/user/api.php"
_IMAGE_RELAY_ENABLED = os.getenv("SLACK_ENABLE_IMAGE_RELAY", "0").lower() in ("1", "true", "yes", "on")

# High-risk Slack quality gate. The immediate Slack alert fires only when
# the underlying episode has sustained evidence: minimum duration, minimum
# number of high-risk frames, and minimum detection confidence. Events that
# fail the gate route to the hourly medium digest — never silently dropped.
# All thresholds tunable via environment variables.
SLACK_HIGH_MIN_DURATION_SEC = float(os.getenv("SLACK_HIGH_MIN_DURATION_SEC", "1.5"))
SLACK_HIGH_MIN_FRAMES = int(os.getenv("SLACK_HIGH_MIN_FRAMES", "2"))
SLACK_HIGH_MIN_CONFIDENCE = float(os.getenv("SLACK_HIGH_MIN_CONFIDENCE", "0.55"))

# ---------------------------------------------------------------------------
# Tiered buffers — drained by digest.py schedulers.
# NOTE: unbounded in-memory. See module docstring.
# ---------------------------------------------------------------------------
_MEDIUM_BUFFER: list[dict] = []
_LOW_BUFFER: list[dict] = []


def slack_configured() -> bool:
    return bool(_WEBHOOK)


def _should_notify(risk_level: str) -> bool:
    return _RISK_ORDER.get(risk_level, 0) >= _RISK_ORDER.get(_MIN_RISK, 3)


def get_medium_buffer() -> list[dict]:
    """Read-only snapshot of the pending medium-risk events (for UI/coaching)."""
    return list(_MEDIUM_BUFFER)


def get_low_buffer() -> list[dict]:
    return list(_LOW_BUFFER)


async def _upload_public_image(client: httpx.AsyncClient, thumb_path: Path) -> str | None:
    try:
        with thumb_path.open("rb") as f:
            r = await client.post(
                _IMAGE_HOST,
                data={"reqtype": "fileupload"},
                files={"fileToUpload": (thumb_path.name, f, "image/jpeg")},
                timeout=20,
            )
        body = r.text.strip()
        if r.status_code == 200 and body.startswith("http"):
            return body
        print(f"[slack] image relay rejected: {r.status_code} {body[:120]}")
    except Exception as exc:
        print(f"[slack] image relay failed: {exc}")
    return None


def _build_blocks(event: dict, image_url: str | None) -> list:
    risk = event["risk_level"]
    emoji = _RISK_EMOJI.get(risk, ":warning:")
    etype_pretty = event["event_type"].replace("_", " ").title()
    narration = event.get("narration") or event.get("summary", "")
    objs = ", ".join(event.get("objects", []))
    confidence_pct = int(round(event.get("confidence", 0) * 100))

    enrich = event.get("enrichment") or {}
    # Plate text is never on the egress payload — we only ever see a salted hash.
    plate_hash = enrich.get("plate_hash")
    color = enrich.get("vehicle_color")
    vtype = enrich.get("vehicle_type")
    readability = enrich.get("readability")

    plate_line = ""
    if plate_hash:
        plate_line = f"*Plate ref:* `{plate_hash}` _(salted — correlation only)_"
    elif readability:
        plate_line = f"*Plate:* _unreadable ({readability})_"

    vehicle_bits = [v for v in (color, vtype) if v]
    vehicle_line = f"*Vehicle:* {' '.join(vehicle_bits)}" if vehicle_bits else ""

    enrich_fields = "  ·  ".join(s for s in (plate_line, vehicle_line) if s)

    kinematics_parts = []
    if event.get("ttc_sec") is not None:
        kinematics_parts.append(f"*TTC:* `{event['ttc_sec']}s`")
    if event.get("distance_m") is not None:
        kinematics_parts.append(f"*Distance:* `{event['distance_m']}m`")
    kinematics_parts.append(f"*Edge px:* `{event['distance_px']}`")
    kinematics_line = "   ".join(kinematics_parts)

    track_ids = event.get("track_ids") or []
    track_line = (
        f"*Track pair:* `{'/'.join(str(t) for t in track_ids)}`"
        if track_ids
        else "*Track pair:* _untracked_"
    )
    duration = event.get("episode_duration_sec")
    duration_line = f"*Episode:* `{duration}s`" if duration else ""

    fields_md = (
        f"*Event ID:* `{event['event_id']}`   {track_line}\n"
        f"*Time:* `{event['wall_time']}`   *Stream t+:* `{event['timestamp_sec']}s`"
        + (f"   {duration_line}" if duration_line else "") + "\n"
        f"*Objects:* {objs}   {kinematics_line}   *Confidence:* `{confidence_pct}%`\n"
        f"*Review SLA:* {_SLA.get(risk, '—')} _(per road_policy.md)_"
    )
    if enrich_fields:
        fields_md += f"\n{enrich_fields}"

    blocks: list = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"{risk.upper()}-risk road event — {etype_pretty}",
            },
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"{emoji} {narration}"},
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": fields_md},
        },
    ]

    if image_url:
        blocks.append(
            {
                "type": "image",
                "image_url": image_url,
                "alt_text": f"{event['event_id']} screenshot",
            }
        )
    else:
        blocks.append(
            {
                "type": "context",
                "elements": [
                    {
                        "type": "mrkdwn",
                        "text": (
                            "_screenshot omitted (image relay disabled)_"
                            if not _IMAGE_RELAY_ENABLED
                            else "_screenshot unavailable (image relay failed)_"
                        ),
                    }
                ],
            }
        )

    return blocks


# ---------------------------------------------------------------------------
# High-risk: fire immediately, full block-kit card.
# ---------------------------------------------------------------------------
async def notify_high(event: dict, thumb_path: Path) -> None:
    """Post a high-risk event to Slack immediately. No tier gating here —
    the caller decides whether this path is used."""
    if not slack_configured():
        return

    image_url: str | None = None
    try:
        async with httpx.AsyncClient() as client:
            if _IMAGE_RELAY_ENABLED and thumb_path and thumb_path.exists():
                image_url = await _upload_public_image(client, thumb_path)

            payload = {
                "blocks": _build_blocks(event, image_url),
                "text": (
                    f"{event['risk_level'].upper()} road event: {event['event_type']} — "
                    f"{event.get('narration') or event.get('summary', '')}"
                ),
            }
            r = await client.post(_WEBHOOK, json=payload, timeout=10)
            if r.status_code != 200 or r.text.strip() != "ok":
                print(f"[slack] webhook rejected: {r.status_code} {r.text[:200]}")
                return
        print(
            f"[slack] notified {event['event_id']} ({event['risk_level']}) "
            f"image={'yes' if image_url else 'no'}"
        )
    except Exception as exc:
        print(f"[slack] notify failed for {event['event_id']}: {exc}")


# ---------------------------------------------------------------------------
# Medium / low buffering — cheap append, no network.
# ---------------------------------------------------------------------------
def buffer_medium(event: dict) -> None:
    """Append a medium-risk event to the hourly digest buffer."""
    _MEDIUM_BUFFER.append(event)


def buffer_low(event: dict) -> None:
    """Append a low-risk event to the daily digest buffer."""
    _LOW_BUFFER.append(event)


def _summarise_counts(events: list[dict]) -> str:
    """'3 vehicle-proximity events, 2 pedestrian-proximity events' ..."""
    counter = Counter(e.get("event_type", "unknown") for e in events)
    parts = []
    for etype, n in counter.most_common():
        pretty = etype.replace("_", "-")
        noun = "event" if n == 1 else "events"
        parts.append(f"{n} {pretty} {noun}")
    return ", ".join(parts) if parts else "no events"


def _format_digest_lines(events: list[dict], limit: int = 25) -> str:
    """Plain-text per-event lines for the digest body (capped)."""
    lines = []
    for e in events[:limit]:
        eid = e.get("event_id", "?")
        etype = e.get("event_type", "event").replace("_", "-")
        when = e.get("wall_time") or f"t+{e.get('timestamp_sec', '?')}s"
        lines.append(f"• `{eid}` — {etype} @ {when}")
    if len(events) > limit:
        lines.append(f"… and {len(events) - limit} more")
    return "\n".join(lines)


async def _post_digest(title: str, summary: str, body: str) -> None:
    if not slack_configured():
        return
    payload = {
        "text": f"{title} — {summary}",
        "blocks": [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": title},
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f":warning: {summary}"},
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": body or "_(no details)_"},
            },
        ],
    }
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(_WEBHOOK, json=payload, timeout=10)
            if r.status_code != 200 or r.text.strip() != "ok":
                print(f"[slack] digest webhook rejected: {r.status_code} {r.text[:200]}")
    except Exception as exc:
        print(f"[slack] digest post failed: {exc}")


async def flush_medium_digest() -> None:
    """Drain the medium buffer and post a single grouped Slack digest.
    No-op if the buffer is empty."""
    if not _MEDIUM_BUFFER:
        return
    events = list(_MEDIUM_BUFFER)
    _MEDIUM_BUFFER.clear()
    summary = _summarise_counts(events) + " in the last hour"
    body = _format_digest_lines(events)
    print(f"[slack] flushing medium digest: {len(events)} events — {summary}")
    await _post_digest(
        title="Medium-risk road digest (hourly)",
        summary=summary,
        body=body,
    )


async def flush_low_daily() -> None:
    """Drain the low buffer and post a daily summary. No-op if empty."""
    if not _LOW_BUFFER:
        return
    events = list(_LOW_BUFFER)
    _LOW_BUFFER.clear()
    summary = _summarise_counts(events) + " in the last 24h"
    body = _format_digest_lines(events)
    print(f"[slack] flushing low daily: {len(events)} events — {summary}")
    await _post_digest(
        title="Low-risk road summary (daily)",
        summary=summary,
        body=body,
    )


# ---------------------------------------------------------------------------
# Backwards-compatible shim. Existing server.py calls notify_event(...)
# which now routes by tier. High fires immediately; medium/low buffer.
# ---------------------------------------------------------------------------
def _passes_high_quality_gate(event: dict) -> tuple[bool, str | None]:
    """High-risk events must clear sustained-evidence gates before firing
    the immediate Slack alert.

    Returns (passes, reason_if_not). Failed events are downgraded to the
    medium digest rather than silently dropped.

    Gates:
      - episode_duration_sec >= SLACK_HIGH_MIN_DURATION_SEC
      - risk_frame_counts['high'] >= SLACK_HIGH_MIN_FRAMES
      - confidence >= SLACK_HIGH_MIN_CONFIDENCE
    """
    duration = float(event.get("episode_duration_sec") or 0.0)
    if duration < SLACK_HIGH_MIN_DURATION_SEC:
        return False, f"episode {duration:.2f}s < min {SLACK_HIGH_MIN_DURATION_SEC}s"

    risk_counts = event.get("risk_frame_counts") or {}
    high_frames = int(risk_counts.get("high", 0))
    if high_frames < SLACK_HIGH_MIN_FRAMES:
        return False, f"only {high_frames} high-risk frame(s) < min {SLACK_HIGH_MIN_FRAMES}"

    confidence = float(event.get("confidence") or 0.0)
    if confidence < SLACK_HIGH_MIN_CONFIDENCE:
        return False, f"confidence {confidence:.2f} < min {SLACK_HIGH_MIN_CONFIDENCE:.2f}"

    return True, None


async def notify_event(event: dict, thumb_path: Path) -> None:
    """Tier-aware dispatcher with high-risk quality gate.

    High-risk events that fail the sustained-evidence gate are downgraded to
    the medium digest rather than firing an immediate Slack alert. Medium
    and low events buffer for periodic digests.
    """
    risk = (event.get("risk_level") or "").lower()
    if risk == "high":
        passes, reason = _passes_high_quality_gate(event)
        if not passes:
            print(
                f"[slack] high-risk event {event.get('event_id')} downgraded "
                f"to medium digest: {reason}"
            )
            buffer_medium(event)
            return
        if _should_notify("high"):
            await notify_high(event, thumb_path)
    elif risk == "medium":
        buffer_medium(event)
    else:
        buffer_low(event)


print(
    f"[slack] configured: {slack_configured()}  "
    f"min_risk: {_MIN_RISK}  "
    f"image_relay: {'enabled' if _IMAGE_RELAY_ENABLED else 'disabled'}"
)
