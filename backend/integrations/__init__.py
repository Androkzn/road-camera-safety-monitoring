"""Outbound channels: edge-to-cloud publisher, Slack alerts.

Everything that crosses a trust boundary from the edge node. The
``edge_publisher`` module handles batched, HMAC-signed delivery to the
cloud receiver; ``slack`` posts tiered notifications (immediate for
high-risk, digested for medium / low) using only redacted public
thumbnails; ``fnol`` shapes an insurer-ready payload (stub — no HTTP
transport wired up). Design rule: no module here does network I/O at
import time.

UI connection
-------------
Page: Admin / Settings page (Slack webhook + cloud publisher config)
UI element: indirect; these modules are the egress side of any event
            the operator sees land in Slack or the cloud dashboard.
"""
