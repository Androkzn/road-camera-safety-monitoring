/**
 * VehicleMap — OpenStreetMap + Leaflet overlay for the admin dashboard.
 *
 * Renders the bundled demo track as a polyline and animates a heading
 * arrow along it using `useVehiclePosition`. The map pans to follow the
 * marker at 2Hz (Leaflet's panTo triggers a re-render on each call, so
 * the tighter 30fps update cadence stays off the map itself).
 */
import "leaflet/dist/leaflet.css";

import { useEffect, useMemo, useRef } from "react";
import L, { type LatLngBoundsLiteral, type LatLngExpression } from "leaflet";
import {
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  useMap,
} from "react-leaflet";

import {
  useDemoTrack,
  useVehiclePosition,
  type DemoTrackBounds,
  type VehiclePosition,
} from "../hooks/useDemoTrack";

import styles from "./VehicleMap.module.css";

const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = "&copy; OpenStreetMap contributors";
const LOOP_SEC = 60;
const FOLLOW_THROTTLE_MS = 500;

function boundsToLatLng(b: DemoTrackBounds): LatLngBoundsLiteral {
  return [
    [b.south, b.west],
    [b.north, b.east],
  ];
}

function buildArrowIcon(headingDeg: number): L.DivIcon {
  // Inline SVG keeps us free of extra assets; the outer transform rotates
  // the glyph to match current compass heading.
  const svg = `
    <div class="${styles.arrowIcon}" style="transform: rotate(${headingDeg}deg)">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M12 2 L20 20 L12 16 L4 20 Z"
              fill="#38bdf8" stroke="#0b0f14" stroke-width="1.2"
              stroke-linejoin="round" />
      </svg>
    </div>
  `;
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

// Smoothly recenters the map as the vehicle moves. Throttled to 2Hz
// because Leaflet's panTo animates, and firing it on every 30fps tick
// produces noticeable jitter.
function FollowVehicle({ position }: { position: VehiclePosition | null }) {
  const map = useMap();
  const lastPanRef = useRef(0);
  useEffect(() => {
    if (!position) return;
    const now = performance.now();
    if (now - lastPanRef.current < FOLLOW_THROTTLE_MS) return;
    lastPanRef.current = now;
    map.panTo([position.lat, position.lng], { animate: true, duration: 0.45 });
  }, [position, map]);
  return null;
}

export function VehicleMap() {
  const { data, isLoading, isError } = useDemoTrack();
  const position = useVehiclePosition(LOOP_SEC);

  const polyline = useMemo<LatLngExpression[]>(() => {
    if (!data?.ok || !data.points) return [];
    return data.points.map((p) => [p.lat, p.lng] as LatLngExpression);
  }, [data]);

  const bounds = useMemo<LatLngBoundsLiteral | null>(() => {
    if (!data?.ok || !data.bounds) return null;
    return boundsToLatLng(data.bounds);
  }, [data]);

  const icon = useMemo(
    () => buildArrowIcon(position?.heading ?? 0),
    [position?.heading],
  );

  if (isLoading) {
    return <div className={styles.wrap}><div className={styles.empty}>Loading track…</div></div>;
  }
  if (isError || !data?.ok || !bounds || polyline.length < 2) {
    return (
      <div className={styles.wrap}>
        <div className={styles.empty}>
          Map unavailable — demo track could not be loaded.
        </div>
      </div>
    );
  }

  const vehicle = data.vehicle;
  const rawBounds = data.bounds!;
  const center: LatLngExpression = position
    ? [position.lat, position.lng]
    : [
        (rawBounds.south + rawBounds.north) / 2,
        (rawBounds.west + rawBounds.east) / 2,
      ];

  return (
    <div className={styles.wrap}>
      {vehicle && (
        <div className={styles.badge}>
          <div className={styles.plate}>{vehicle.plate}</div>
          <div className={styles.model}>{vehicle.model}</div>
          <div className={styles.company}>{vehicle.company}</div>
          <div className={styles.speed}>
            <span className={styles.speedValue}>
              {(position?.speedKmh ?? 0).toFixed(1)}
            </span>
            <span className={styles.speedUnit}>km/h</span>
          </div>
        </div>
      )}
      <MapContainer
        className={styles.map}
        bounds={bounds}
        center={center}
        zoom={13}
        scrollWheelZoom
      >
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
        <Polyline
          positions={polyline}
          pathOptions={{ color: "#38bdf8", weight: 3, opacity: 0.75 }}
        />
        {position && (
          <Marker position={[position.lat, position.lng]} icon={icon} />
        )}
        <FollowVehicle position={position} />
      </MapContainer>
    </div>
  );
}
