"use client";

import { useState } from "react";
import { useT } from "@/components/Language";
import { translateError, type T } from "@/lib/i18n";
import { money } from "@/lib/region";
import type { Booking } from "@/lib/types";

/** One person on a booking as the server describes them (lib/place-withdrawals.ts `WithdrawOption`). */
interface Option {
  who: "customer" | "participant" | "unnamed";
  placeId: number | null;
  participantId: number | null;
  name: string | null;
  allowed: boolean;
  refusal?: { error: string; code?: string; vars?: Record<string, string | number> };
  price?: number;
  refund?: number;
  kept?: number;
  owedLess?: number;
  units?: number;
  how?: "credit" | "online" | "hand" | "pass" | "none";
}

/** What taking somebody off would do to the money, as the customer reads it. */
export function withdrawMoneyLine(t: T, o: Pick<Option, "price" | "refund" | "kept" | "owedLess" | "units" | "how">): string {
  const price = o.price ?? 0;
  const units = o.units ?? 0;
  if (price <= 0 && units <= 0) return t("ent.msg.noPrice");
  const parts: string[] = [];
  if ((o.owedLess ?? 0) > 0) parts.push(t("ent.msg.owedLess", { amount: money(o.owedLess!) }));
  if ((o.kept ?? 0) > 0) parts.push(t("ent.msg.kept", { kept: money(o.kept!) }));
  if ((o.refund ?? 0) > 0)
    parts.push(t(o.how === "credit" ? "ent.msg.toCredit" : o.how === "online" ? "ent.msg.toCard" : "ent.msg.byHand", { amount: money(o.refund!) }));
  if (units > 0) parts.push(t("ent.msg.toPass", { n: units }));
  if (parts.length === 0) parts.push(t("ent.msg.wholeStays"));
  return parts.join(" ");
}

/**
 * Who is on a booking, and taking one of them off while the others stay booked
 * (docs/features/booking.md#taking-one-person-off-a-booking): a child who
 * cannot come, the customer themself no longer playing, or a place a group
 * no longer needs. Each says what it would do to the money before anything is
 * done, or why it cannot be done here. By code and phone (`/my-booking`), or
 * for the account's own booking (`bookingId`).
 */
export function WithdrawPeople({
  source,
  onDone,
}: {
  source: { code: string; phone: string } | { bookingId: number };
  onDone: (booking: Booking, message: string) => void;
}) {
  const t = useT();
  const [options, setOptions] = useState<Option[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byCode = "code" in source;
  const url = byCode ? "/api/bookings/withdraw" : "/api/my/bookings/withdraw";

  async function open() {
    setError(null);
    setBusy(true);
    try {
      const query = byCode
        ? `code=${encodeURIComponent(source.code)}&phone=${encodeURIComponent(source.phone)}`
        : `bookingId=${source.bookingId}`;
      const res = await fetch(`${url}?${query}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("ent.who.failed"));
      setOptions(data.options as Option[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ent.who.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function takeOff(o: Option) {
    const line = withdrawMoneyLine(t, o);
    if (!window.confirm(o.who === "unnamed" ? t("ent.who.confirmPlace", { money: line }) : t("ent.who.confirm", { name: o.name ?? "", money: line }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...source,
          ...(o.who === "unnamed" ? { unnamed: 1 } : o.who === "customer" ? { customer: true } : { participantId: o.participantId }),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("ent.who.failed"));
      const done = withdrawMoneyLine(t, data.withdrawal);
      setOptions(null);
      onDone(data.booking, o.who === "unnamed" ? t("ent.who.donePlace", { money: done }) : t("ent.who.done", { name: o.name ?? "", money: done }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ent.who.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (options === null)
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => void open()}
          disabled={busy}
          className="w-full rounded-lg border border-slate-300 py-2 text-sm font-semibold text-slate-700 hover:border-teal-500 hover:text-teal-700 disabled:opacity-50"
        >
          {busy ? t("ent.who.loading") : t("ent.who.open")}
        </button>
        {error && <p className="mt-1 text-sm font-medium text-red-700">{error}</p>}
      </div>
    );

  return (
    <section className="mt-3 rounded-lg border border-slate-200 p-3 text-sm" aria-label={t("ent.who.title")}>
      <h3 className="font-semibold">{t("ent.who.title")}</h3>
      {options.length === 0 && <p className="mt-1 text-slate-600">{t("ent.who.none")}</p>}
      <ul className="mt-2 space-y-2">
        {options.map((o, i) => (
          <li key={o.placeId ?? `unnamed-${i}`} className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{o.who === "unnamed" ? t("ent.who.unnamed") : o.name}</span>
            {o.allowed ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-600">{withdrawMoneyLine(t, o)}</span>
                <button
                  type="button"
                  onClick={() => void takeOff(o)}
                  disabled={busy}
                  className="min-h-9 rounded-lg border border-red-300 px-3 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  {o.who === "unnamed" ? t("ent.who.giveUp") : t("ent.who.takeOff")}
                </button>
              </span>
            ) : (
              <span className="text-xs text-slate-500">{t("ent.who.whyNot", { reason: translateError(t, o.refusal ?? null) })}</span>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
    </section>
  );
}
