/**
 * useDemoTrack — fetches the bundled demo GPS track and derives live
 * playback state (position + speed + heading) for the admin map overlay.
 *
 * The track spans ~7500s of real driving but the MP4 loops in ~60s, so
 * playback time is compressed onto the track time via a `loopSec`
 * multiplier. Speed is always computed from the *real* GPS delta between
 * surrounding points (haversine / real time), never the sped-up playback
 * time — otherwise a 120x speedup would report triple-digit km/h.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { fetchJson } from "../../../shared/lib/fetchClient";

export interface TrackPoint {
  lat: number;
  lng: number;
  t_sec: number;
}

export interface DemoVehicle {
  plate: string;
  model: string;
  company: string;
  vehicle_id: string;
}

export interface DemoTrackBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface DemoVideoMeta {
  key?: string;
  path?: string;
  creation_time?: string | null;
  duration_sec?: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string | null;
}

export interface DemoTrackResponse {
  ok: boolean;
  vehicle?: DemoVehicle;
  points?: TrackPoint[];
  total_duration_sec?: number;
  bounds?: DemoTrackBounds;
  /** Present when the track is loaded from ``/api/demo/video-track``: in
   *  that case ``points[].t_sec`` is video-relative (0 == first frame)
   *  and the marker can be driven directly by the MP4 playback head —
   *  no loop compression needed. */
  video?: DemoVideoMeta | null;
}

/** Known video keys understood by ``/api/demo/video-track``. Keep in sync
 *  with ``_DEMO_VIDEO_SOURCES`` in ``road_safety/server.py``. */
export type DemoVideoKey = "iphone" | "dji";

export interface VehiclePosition {
  lat: number;
  lng: number;
  speedKmh: number;
  bearing: number;
  heading: number;
  point: TrackPoint;
}

const TRACK_QUERY_KEY_BASE = "demoTrack";
const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

// Great-circle distance in meters (haversine).
function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Initial compass bearing from A to B (degrees, 0=N, 90=E).
function bearingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Fetch the GPS track for the map overlay.
 *
 * - When ``videoKey`` is provided, hits ``/api/demo/video-track?video=...``
 *   which returns a track sliced to the MP4's recording window with
 *   ``t_sec`` re-based to ``0 == first frame``. The marker can then be
 *   driven directly from the MP4 playback head — no loop compression —
 *   so the GPS dot stays in sync with what the camera is showing.
 * - When omitted, falls back to ``/api/demo/track`` (full timeline,
 *   loop-friendly). Used when no dashcam video key is known.
 */
export function useDemoTrack(videoKey?: DemoVideoKey | null) {
  return useQuery({
    queryKey: ["admin", TRACK_QUERY_KEY_BASE, videoKey ?? null] as const,
    queryFn: () =>
      fetchJson<DemoTrackResponse>(
        videoKey
          ? `/api/demo/video-track?video=${encodeURIComponent(videoKey)}`
          : "/api/demo/track",
      ),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export interface PlaybackClock {
  /** Server-reported playback head (seconds). This is the MP4's
   *  ``CAP_PROP_POS_MSEC`` when available, else stream uptime. Advances
   *  only while the reader thread is running — pauses propagate. Wraps
   *  naturally when the MP4 loops. */
  uptimeSec: number;
  /** Whether the backing stream is currently running. */
  running: boolean;
  /** Duration of the backing MP4 in seconds. When set, the track loop is
   *  aligned to the video loop (GPS marker resets when the video resets).
   *  When null, falls back to a fixed ``loopSec`` wallclock compression. */
  videoDurationSec?: number | null;
}

/**
 * useVehiclePosition — returns an animated position for the map marker.
 *
 * Accepts an optional ``clock`` sourced from the primary dashcam stream's
 * ``uptime_sec`` + ``running`` flag. When provided:
 *   - the marker only moves while the stream is running,
 *   - it freezes when the video pauses,
 *   - it resynchronises to the server's uptime on every poll (5 s cadence),
 *     so drift from the local ``performance.now()`` never exceeds one poll.
 *
 * When ``clock`` is omitted, falls back to a plain wallclock loop so the
 * component still works on pages without a running stream.
 *
 * The full GPS track spans ~7500 s of real driving; we compress it onto
 * ``loopSec`` seconds of playback time so the marker visibly moves. Speed
 * is always computed from the *real* GPS delta between the surrounding
 * points (haversine / real time), so it reflects actual driving speed
 * instead of being inflated by the playback compression.
 */
export function useVehiclePosition(
  loopSec = 60,
  clock?: PlaybackClock | null,
): VehiclePosition | null {
  const { data } = useDemoTrack();
  const [pos, setPos] = useState<VehiclePosition | null>(null);
  const rafRef = useRef<number | null>(null);
  // Local wallclock playhead in seconds. Advances 1s per real second
  // while ``clock.running`` is true; freezes when false; resumes from
  // where it froze. We deliberately do NOT mirror the server's
  // ``uptime_sec`` because the backend destroys the reader on pause,
  // which makes ``uptime_sec`` jump to 0 and snap the marker to the
  // start of the route — so the original "PAUSE ALL → START ALL"
  // sequence reset the GPS dot every cycle.
  const playheadRef = useRef<number>(0);
  // Mirror ``clock`` into a ref so the rAF loop reads fresh values
  // without the effect remounting on every parent render.
  const clockRef = useRef<PlaybackClock | null | undefined>(clock);
  clockRef.current = clock;

  useEffect(() => {
    if (!data?.ok || !data.points || data.points.length < 2) {
      setPos(null);
      return;
    }
    const points = data.points;
    const duration = data.total_duration_sec ?? points[points.length - 1]!.t_sec;
    if (duration <= 0) {
      setPos(null);
      return;
    }

    console.debug("[map-sync] effect mount", {
      points: points.length,
      duration_sec: duration,
      loopSec,
    });

    const FRAME_MS = 1000 / 30;
    let lastFrame = 0;
    let lastTickMs = performance.now();
    let lastDebugMs = 0;
    const DEBUG_EVERY_MS = 2000;

    const tick = (now: number) => {
      if (now - lastFrame >= FRAME_MS) {
        lastFrame = now;
        const c = clockRef.current;
        const dtSec = (now - lastTickMs) / 1000;
        lastTickMs = now;

        // Advance only when the stream is running (or when there is no
        // clock at all — pages without a stream still get a moving demo
        // marker). Pause behavior is just "skip the advance".
        if (!c || c.running) {
          playheadRef.current += dtSec;
        }

        const playheadSec = Math.max(0, playheadRef.current);
        // Compress the ~7500 s GPS path onto a ``loopSec`` (60 s) wall-
        // clock loop. Each wall-second covers ~125 s of GPS time —
        // visible motion against widely-spaced waypoints.
        const trackTime = ((playheadSec / loopSec) * duration) % duration;
        const next = sampleTrack(points, trackTime);
        if (next) setPos(next);

        if (now - lastDebugMs >= DEBUG_EVERY_MS) {
          lastDebugMs = now;
          console.debug("[map-sync] tick", {
            clockRunning: c?.running,
            playhead: playheadSec.toFixed(2),
            trackTime: trackTime.toFixed(1),
            lat: next?.lat.toFixed(5),
            lng: next?.lng.toFixed(5),
          });
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [data, loopSec]);

  return pos;
}

// Binary-search the track for the pair surrounding `tSec`, then lerp.
function sampleTrack(
  points: TrackPoint[],
  tSec: number,
): VehiclePosition | null {
  if (points.length < 2) return null;
  const firstPt = points[0]!;
  const lastPt = points[points.length - 1]!;

  if (tSec <= firstPt.t_sec) {
    const second = points[1]!;
    return makePosition(firstPt, second, 0);
  }
  if (tSec >= lastPt.t_sec) {
    const prev = points[points.length - 2]!;
    return makePosition(prev, lastPt, 1);
  }

  // Binary search for the largest index with t_sec <= tSec.
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (points[mid]!.t_sec <= tSec) lo = mid;
    else hi = mid - 1;
  }
  const a = points[lo]!;
  const b = points[lo + 1] ?? a;
  const span = b.t_sec - a.t_sec;
  const f = span > 0 ? (tSec - a.t_sec) / span : 0;
  return makePosition(a, b, f);
}

function makePosition(
  a: TrackPoint,
  b: TrackPoint,
  f: number,
): VehiclePosition {
  const lat = a.lat + (b.lat - a.lat) * f;
  const lng = a.lng + (b.lng - a.lng) * f;
  const distM = haversineMeters(a, b);
  const dtSec = Math.max(b.t_sec - a.t_sec, 0.001);
  // Clamp impossibly-large gaps (discrete segments in the source data can
  // leave a two-point pair kilometers apart after a recording break).
  const speedMs = dtSec > 60 ? 0 : distM / dtSec;
  const speedKmh = speedMs * 3.6;
  const heading = bearingDeg(a, b);
  return {
    lat,
    lng,
    speedKmh,
    bearing: heading,
    heading,
    point: { lat, lng, t_sec: a.t_sec + (b.t_sec - a.t_sec) * f },
  };
}
