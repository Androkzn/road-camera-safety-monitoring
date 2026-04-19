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

export interface DemoTrackResponse {
  ok: boolean;
  vehicle?: DemoVehicle;
  points?: TrackPoint[];
  total_duration_sec?: number;
  bounds?: DemoTrackBounds;
}

export interface VehiclePosition {
  lat: number;
  lng: number;
  speedKmh: number;
  bearing: number;
  heading: number;
  point: TrackPoint;
}

const TRACK_QUERY_KEY = ["admin", "demoTrack"] as const;
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

export function useDemoTrack() {
  return useQuery({
    queryKey: TRACK_QUERY_KEY,
    queryFn: () => fetchJson<DemoTrackResponse>("/api/demo/track"),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/**
 * useVehiclePosition — returns an animated position derived from wall
 * clock. The full track is replayed every `loopSec` seconds so the
 * marker visibly moves (the real GPS data spans ~2 hours).
 */
export function useVehiclePosition(loopSec = 60): VehiclePosition | null {
  const { data } = useDemoTrack();
  const [pos, setPos] = useState<VehiclePosition | null>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

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
    startRef.current = performance.now();

    // ~30 fps is plenty for a gently-moving marker on a map tile.
    const FRAME_MS = 1000 / 30;
    let lastTick = 0;

    const tick = (now: number) => {
      if (now - lastTick >= FRAME_MS) {
        lastTick = now;
        const start = startRef.current ?? now;
        const elapsedSec = (now - start) / 1000;
        const trackTime = ((elapsedSec / loopSec) * duration) % duration;
        const next = sampleTrack(points, trackTime);
        if (next) setPos(next);
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
