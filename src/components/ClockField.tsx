"use client";

import { clockOf, parseClock } from "@/lib/interval";

/**
 * A time of day to the minute, as minutes of the business day. With `after`,
 * it is an end: a time at or before `after` is the next morning (00:00 is
 * midnight, 01:30 the night's last half hour), up to 4 AM.
 */
export function ClockField({
  value,
  onChange,
  after,
  label,
  className,
}: {
  value: number;
  onChange: (minute: number) => void;
  after?: number;
  label: string;
  className?: string;
}) {
  return (
    <input
      type="time"
      step={60}
      aria-label={label}
      value={clockOf(value)}
      onChange={(e) => {
        let m = parseClock(e.target.value);
        if (m === null) return;
        if (after !== undefined && m <= after) m += 1440;
        if (m > 1680) return;
        onChange(m);
      }}
      className={className}
    />
  );
}
