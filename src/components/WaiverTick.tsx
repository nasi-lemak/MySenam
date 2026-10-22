"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/Language";

/**
 * The box to tick for a venue's waiver (lib/waivers.ts), with the waiver a
 * click away. Nothing at all where the venue asks for none. A number that has
 * agreed already is not refused for leaving it unticked, but the box is shown
 * anyway: whether a number has agreed is not something to tell a stranger.
 */
export default function WaiverTick({
  venueId,
  venueName,
  checked,
  onChange,
}: {
  venueId: number;
  venueName: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const t = useT();
  const [asks, setAsks] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/venues/${venueId}/waiver`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => live && setAsks(!!data?.waiver))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [venueId]);

  if (!asks) return null;
  return (
    <label className="mt-2 flex items-start gap-2 text-xs text-slate-700">
      <input type="checkbox" required checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-teal-600" />
      <span>
        {t("form.waiverAgree", { venue: venueName })}{" "}
        <a href={`/venue/${venueId}/waiver`} target="_blank" rel="noreferrer" className="font-medium text-teal-700 underline">
          {t("form.waiverRead")}
        </a>
      </span>
    </label>
  );
}
