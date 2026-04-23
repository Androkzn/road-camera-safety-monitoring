"""Speed-adaptive frame-rate policy.

Pure function: given the current ego-speed proxy (m/s), return the
perception FPS we want the stream reader to run at. No I/O, no state —
the caller owns smoothing and applies the result via
``StreamReader.set_target_fps``.

Policy rationale
----------------
- **Stationary / crawl** (<2 m/s, ~7 km/h): drop to half base. A parked
  or creeping camera generates little new information per frame; CPU
  spent here is wasted.
- **Normal driving** (2–15 m/s, ~7–54 km/h): run at base FPS — the
  value the operator configured in settings / ``ROAD_TARGET_FPS``.
- **Highway** (>15 m/s, ~54 km/h+): double base FPS. Closure rates
  scale with speed, and TTC gates need more samples per second to
  catch a fast cut-in before it's too late.

A hard floor of 1 fps is enforced so we never stop sampling entirely,
and the result is clamped to ``[0.5 * base, 2.0 * base]`` so a runaway
speed reading can't blow up compute.
"""

LOW_SPEED_THRESHOLD_MPS = 2.0
HIGH_SPEED_THRESHOLD_MPS = 15.0

LOW_SPEED_MULTIPLIER = 0.5
HIGH_SPEED_MULTIPLIER = 2.0

MIN_FPS_FLOOR = 1.0


def fps_for_speed(speed_mps: float | None, base_fps: float) -> float:
    """Return the target FPS to run at for the given ego-speed proxy.

    Args:
        speed_mps: Optical-flow ego-speed proxy from
            ``EgoMotionEstimator.speed_proxy_mps``. ``None`` when the
            estimator has low confidence (e.g. featureless sky, heavy
            rain) — in that case we fall back to ``base_fps`` rather
            than guess.
        base_fps: The operator-configured baseline (``config.TARGET_FPS``
            or the current Settings Console value).

    Returns:
        The FPS the reader should target. Always ``>= MIN_FPS_FLOOR``
        and within ``[0.5 * base_fps, 2.0 * base_fps]``.
    """
    if speed_mps is None or base_fps <= 0:
        return max(base_fps, MIN_FPS_FLOOR)

    if speed_mps < LOW_SPEED_THRESHOLD_MPS:
        target = base_fps * LOW_SPEED_MULTIPLIER
    elif speed_mps > HIGH_SPEED_THRESHOLD_MPS:
        target = base_fps * HIGH_SPEED_MULTIPLIER
    else:
        target = base_fps

    return max(target, MIN_FPS_FLOOR)
