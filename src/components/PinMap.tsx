"use client";

import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";

export interface MapPoint {
  lat: number;
  lng: number;
}

/** All of Malaysia, for a map with nothing on it yet. */
const MALAYSIA: [number, number] = [4.2, 108];
const STREET_ZOOM = 17;

/** A teal pin drawn in place, so there are no marker images to ship. */
const PIN_HTML =
  '<svg width="28" height="40" viewBox="0 0 28 40" aria-hidden="true"><path d="M14 0C6.3 0 0 6.2 0 13.9 0 24.3 14 40 14 40s14-15.7 14-26.1C28 6.2 21.7 0 14 0z" fill="#0d9488"/><circle cx="14" cy="14" r="5.5" fill="#fff"/></svg>';

/**
 * A map with a venue's pin on it.
 *
 * Given `onPin`, it is a form field: a tap drops the pin and a drag moves it.
 * Without, it shows where a venue says it is — with `found`, where its
 * address leads, as a grey ring beside it — for somebody deciding whether to
 * believe it.
 *
 * Leaflet reaches for `window` the moment it loads, so it is loaded here,
 * in the browser, rather than imported where the server would run it too.
 * Tiles are OpenStreetMap's, which ask for credit and light use; an
 * application form and an approvals list are both.
 */
export default function PinMap({
  pin,
  onPin,
  found,
  focus,
  height = 260,
}: {
  pin: MapPoint | null;
  onPin?: (p: MapPoint) => void;
  found?: MapPoint | null;
  /** Fly here whenever it changes — an address just looked up, say. */
  focus?: MapPoint | null;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const lib = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const marker = useRef<Leaflet.Marker | null>(null);
  const ring = useRef<Leaflet.CircleMarker | null>(null);
  const onPinNow = useRef(onPin);
  onPinNow.current = onPin;
  const editable = onPin !== undefined;
  const [ready, setReady] = useState(false);

  // Where it opens: on the pin, on what the address found, or on the country.
  const start = useRef(pin ?? focus ?? found ?? null);

  useEffect(() => {
    let gone = false;
    void import("leaflet").then((mod) => {
      if (gone || !box.current) return;
      const L = (mod as unknown as { default?: typeof Leaflet }).default ?? mod;
      lib.current = L;
      const at = start.current;
      const m = L.map(box.current, { scrollWheelZoom: false }).setView(
        at ? [at.lat, at.lng] : MALAYSIA,
        at ? STREET_ZOOM : 5
      );
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(m);
      if (editable) m.on("click", (e: Leaflet.LeafletMouseEvent) => onPinNow.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
      map.current = m;
      setReady(true);
    });
    return () => {
      gone = true;
      map.current?.remove();
      map.current = marker.current = ring.current = null;
    };
  }, [editable]);

  const [pinLat, pinLng] = [pin?.lat, pin?.lng];
  useEffect(() => {
    const L = lib.current;
    const m = map.current;
    if (!ready || !L || !m) return;
    if (pinLat === undefined || pinLng === undefined) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (marker.current) {
      marker.current.setLatLng([pinLat, pinLng]);
      return;
    }
    const icon = L.divIcon({ html: PIN_HTML, className: "", iconSize: [28, 40], iconAnchor: [14, 40] });
    const placed = L.marker([pinLat, pinLng], { icon, draggable: editable, title: "The venue" }).addTo(m);
    placed.on("dragend", () => {
      const p = placed.getLatLng();
      onPinNow.current?.({ lat: p.lat, lng: p.lng });
    });
    marker.current = placed;
  }, [ready, pinLat, pinLng, editable]);

  const [foundLat, foundLng] = [found?.lat, found?.lng];
  useEffect(() => {
    const L = lib.current;
    const m = map.current;
    if (!ready || !L || !m) return;
    ring.current?.remove();
    ring.current = null;
    if (foundLat === undefined || foundLng === undefined) return;
    ring.current = L.circleMarker([foundLat, foundLng], {
      radius: 10,
      color: "#475569",
      weight: 2,
      dashArray: "4 4",
      fillOpacity: 0.1,
    }).addTo(m);
    // Looking, not placing: show the pin and the address together.
    if (!editable && pinLat !== undefined && pinLng !== undefined)
      m.fitBounds(L.latLngBounds([pinLat, pinLng], [foundLat, foundLng]), { padding: [30, 30], maxZoom: STREET_ZOOM });
  }, [ready, foundLat, foundLng, pinLat, pinLng, editable]);

  const [focusLat, focusLng] = [focus?.lat, focus?.lng];
  useEffect(() => {
    if (ready && focusLat !== undefined && focusLng !== undefined)
      map.current?.setView([focusLat, focusLng], STREET_ZOOM);
  }, [ready, focusLat, focusLng]);

  return (
    <div
      ref={box}
      style={{ height }}
      className="relative z-0 w-full overflow-hidden rounded-lg border border-slate-300 bg-slate-100"
      data-testid="pin-map"
    />
  );
}

/** Google Maps at a point, for a closer look and Street View. */
export function googleMapsLink(p: MapPoint): string {
  return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
}

export function streetViewLink(p: MapPoint): string {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lng}`;
}
