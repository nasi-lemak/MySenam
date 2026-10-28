"use client";

import { useState } from "react";
import { COUNTER_METHODS, type CounterMethod } from "@/lib/types";
import { useStaffT } from "./StaffLanguage";

/**
 * A fee marked paid at the counter (a tournament entry, a league season): one
 * tap opens the four ways, the second says which; paid, a tap takes the mark
 * back. The way goes on its receipt and into the cash-up (X1-2).
 */
export function PayMark({
  paid,
  paidLabel,
  unpaidLabel,
  onPaid,
  onUnpaid,
  className,
}: {
  paid: boolean;
  paidLabel: string;
  unpaidLabel: string;
  onPaid: (via: CounterMethod) => void;
  onUnpaid: () => void;
  className?: string;
}) {
  const t = useStaffT();
  const [choosing, setChoosing] = useState(false);
  if (paid)
    return (
      <button type="button" onClick={onUnpaid} className={`${className ?? ""} bg-emerald-50 text-emerald-700`}>
        {paidLabel}
      </button>
    );
  if (!choosing)
    return (
      <button type="button" onClick={() => setChoosing(true)} className={className}>
        {unpaidLabel}
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs" role="group" aria-label={t("p8b.via.field")}>
      {COUNTER_METHODS.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => {
            setChoosing(false);
            onPaid(m);
          }}
          className="rounded border border-slate-300 px-2 py-0.5 hover:border-teal-500"
        >
          {t(`c.via.${m}`)}
        </button>
      ))}
      <button type="button" onClick={() => setChoosing(false)} className="px-1 text-slate-500 underline">
        {t("c.neverMind")}
      </button>
    </span>
  );
}

/**
 * How the desk took the money (X1-2): cash, the QR scheme, a transfer or a
 * card terminal, the same four a booking marked paid asks. Nothing chosen to
 * begin with, so a sale is never put down as cash by default.
 */
export function MethodSelect({
  value,
  onChange,
  className,
  required = true,
}: {
  value: CounterMethod | "";
  onChange: (via: CounterMethod | "") => void;
  className?: string;
  required?: boolean;
}) {
  const t = useStaffT();
  return (
    <label className="flex flex-col text-xs font-medium text-slate-500">
      {t("p8b.via.field")}
      <select
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value as CounterMethod | "")}
        className={`mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none ${className ?? ""}`}
      >
        <option value="">{t("p8b.via.choose")}</option>
        {COUNTER_METHODS.map((m) => (
          <option key={m} value={m}>
            {t(`c.via.${m}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
