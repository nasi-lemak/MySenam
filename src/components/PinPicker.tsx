"use client";

import { readJson } from "@/lib/read-response";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import type { MapPoint } from "./PinMap";

const PinMap = dynamic(() => import("./PinMap"), { ssr: false });

export interface PinPickerText {
  label: string;
  hint: string;
  find: string;
  useLocation: string;
  looking: string;
  found: string;
  notFound: string;
  pinned: string;
  locationFailed: string;
}

/** For the dashboard, which is in English. */
export const PIN_TEXT_EN: PinPickerText = {
  label: "Where is it on the map?",
  hint: "Tap the map on the entrance. Drag the pin to move it.",
  find: "Find the address",
  useLocation: "I'm there now: use my location",
  looking: "Looking…",
  found: "The grey ring is where the address leads. Now tap the entrance.",
  notFound: "That address isn't on the map. Move the map there and tap the entrance.",
  pinned: "Pinned. Drag the pin if it isn't quite right.",
  locationFailed: "Couldn't get your location. Tap the map instead.",
};

type Status = "idle" | "looking" | "found" | "notFound" | "locationFailed";

/**
 * Where a venue is, as a form field: look its address up, or use the phone's
 * own location from inside the venue, then tap or drag the pin onto the
 * entrance. The pin is the applicant's own claim; the lookup only moves the
 * map, so a pin is never somewhere nobody chose.
 */
export default function PinPicker({
  query,
  pin,
  onPin,
  text,
}: {
  /** The address as typed so far. */
  query: string;
  pin: MapPoint | null;
  onPin: (p: MapPoint | null) => void;
  text: PinPickerText;
}) {
  const [found, setFound] = useState<MapPoint | null>(null);
  // Where the map last flew to: a looked-up address, or where the phone is.
  const [view, setView] = useState<MapPoint | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  const lookUp = useCallback(async (q: string) => {
    setStatus("looking");
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = (await readJson(res)) as { found?: MapPoint | null };
      if (res.ok && data.found) {
        const at = { lat: data.found.lat, lng: data.found.lng };
        setFound(at);
        setView(at);
        setStatus("found");
      } else setStatus("notFound");
    } catch {
      setStatus("notFound");
    }
  }, []);

  // Once they have typed an address and paused, open the map on it — until
  // they have put the pin down themselves.
  const q = query.trim();
  useEffect(() => {
    if (pin || q.length < 8) return;
    const timer = setTimeout(() => void lookUp(q), 1200);
    return () => clearTimeout(timer);
  }, [q, pin, lookUp]);

  function here() {
    if (!navigator.geolocation) return setStatus("locationFailed");
    setStatus("looking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setFound(null);
        setView(p);
        onPin(p);
        setStatus("idle");
      },
      () => setStatus("locationFailed"),
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }

  const message = pin && status !== "looking" ? text.pinned : status === "idle" ? text.hint : text[status];
  const button =
    "rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-700">{text.label}</span>
        <span className="flex gap-2">
          <button type="button" className={button} disabled={q.length < 3 || status === "looking"} onClick={() => void lookUp(q)}>
            {text.find}
          </button>
          <button type="button" className={button} onClick={here}>
            {text.useLocation}
          </button>
        </span>
      </div>
      <div className="mt-2">
        <PinMap pin={pin} onPin={onPin} found={found} focus={view} />
      </div>
      <p className={`mt-1 text-xs ${pin ? "text-emerald-700" : "text-slate-500"}`} aria-live="polite">
        {message}
      </p>
    </div>
  );
}
