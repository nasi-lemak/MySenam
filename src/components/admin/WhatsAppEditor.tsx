"use client";

import { useCallback, useEffect, useState } from "react";
import type { Pack } from "@/lib/whatsapp-credit";
import type { Usage } from "@/lib/whatsapp-usage";
import { money } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

type Mode = "off" | "urgent" | "all";

const MODES: Mode[] = ["urgent", "all", "off"];

interface State {
  mode: Mode;
  reminders: boolean;
  available: boolean;
  prepaid: boolean;
  balance: number;
  pack: { messages: number; price: number };
  packs: Pack[];
  usage: Usage;
  chatReplies: boolean;
  canPayOnline: boolean;
}

/**
 * WhatsApp for one venue: urgent news only (the default, included), everything
 * (the rest from prepaid credit on a marketplace), or off. Email and the code
 * on screen are always there whatever this says.
 */
export function WhatsAppEditor({ venueId, isOwner }: { venueId: number; isOwner: boolean }) {
  const t = useStaffT();
  const LABEL: Record<Mode, string> = { urgent: t("wa.mode.urgent"), all: t("wa.mode.all"), off: t("wa.mode.off") };
  const NOTE: Record<Mode, string> = { urgent: t("wa.mode.urgentNote"), all: t("wa.mode.allNote"), off: t("wa.mode.offNote") };
  const BUTTON: Record<Mode, string> = { urgent: t("wa.button.urgent"), all: t("wa.button.all"), off: t("wa.button.off") };
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bookings, setBookings] = useState("");
  const [grant, setGrant] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/whatsapp?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) setS(await res.json());
  }, [venueId]);
  useEffect(() => {
    if (open && s === null) void load();
  }, [open, s, load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...body }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(t.err(out, t("wa.requestFailed")));
      if (typeof out.url === "string") return window.location.assign(out.url);
      setS(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("wa.requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  // About one WhatsApp message per booking, and one in ten more for cancellations.
  const perMonth = Math.ceil((Number(bookings) * 11) / 10);
  const packsNeeded = s && perMonth > 0 ? Math.ceil(perMonth / s.pack.messages) : 0;

  return (
    <div className="w-full border-t border-slate-100 pt-2 text-sm">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
        {open
          ? t("wa.close")
          : s
            ? s.mode === "all" && s.prepaid
              ? t("wa.button.allLeft", { n: s.balance })
              : BUTTON[s.mode]
            : t("wa.messages")}
      </button>
      {open && s && (
        <div className="mt-2 space-y-3">
          <p className="text-xs text-slate-500">
            {t("wa.intro")}
            {s.prepaid && ` ${t("wa.prepaidNote", { messages: s.pack.messages, price: money(s.pack.price) })}`}
          </p>
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
          {!s.available ? (
            <p className="text-xs text-amber-700">{t("wa.notAvailable")}</p>
          ) : (
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("wa.messages")}>
                {MODES.map((m) => (
                  <label
                    key={m}
                    className={`cursor-pointer rounded-lg border p-2.5 text-xs ${s.mode === m ? "border-teal-600 bg-teal-50" : "border-slate-200"}`}
                  >
                    <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                      <input
                        type="radio"
                        name={`wa-mode-${venueId}`}
                        checked={s.mode === m}
                        disabled={busy}
                        onChange={() => act({ action: "mode", mode: m })}
                      />
                      {LABEL[m]}
                      {m === "urgent" && <span className="font-normal text-slate-500">{t("wa.default")}</span>}
                    </span>
                    <span className="mt-1 block text-slate-500">{NOTE[m]}</span>
                  </label>
                ))}
              </div>
              {s.mode === "all" && s.prepaid && (
                <span className={`text-xs ${s.balance === 0 ? "font-semibold text-amber-700" : "text-slate-600"}`}>
                  {s.balance === 0 ? t("wa.leftNone", { n: s.balance }) : t("wa.left", { n: s.balance })}
                </span>
              )}
              {s.mode === "all" && (
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={s.reminders}
                    disabled={busy}
                    onChange={(e) => act({ action: e.target.checked ? "remindersOn" : "remindersOff" })}
                  />
                  {t("wa.reminders")}
                </label>
              )}
              <span className="block text-xs text-slate-500">
                {t("wa.thisMonth", {
                  list: [
                    t("wa.usageUrgent", { n: s.usage.urgent }),
                    ...(s.usage.paid > 0 || s.mode === "all" ? [t("wa.usagePaid", { n: s.usage.paid })] : []),
                    ...(s.usage.free > 0 ? [t("wa.usageFree", { n: s.usage.free })] : []),
                  ].join(", "),
                })}
              </span>
            </div>
          )}

          {s.prepaid && s.available && s.mode === "all" && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  disabled={busy}
                  onClick={() => act({ action: "buy" })}
                  className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  {t("wa.buy", { n: s.pack.messages, price: money(s.pack.price) })}
                </button>
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  {t("wa.bookingsAMonth")}
                  <input
                    value={bookings}
                    onChange={(e) => setBookings(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    placeholder={t("wa.bookingsExample")}
                    aria-label={t("wa.bookingsAMonth")}
                    className="w-20 rounded-md border border-slate-300 px-2 py-1"
                  />
                </label>
                {perMonth > 0 && (
                  <span className="text-xs text-slate-600" data-testid="estimate">
                    {t.plural("wa.estimate", packsNeeded, { messages: perMonth, amount: money((packsNeeded * s.pack.price).toFixed(2)) })}
                  </span>
                )}
              </div>
              {s.packs.length > 0 && (
                <ul className="space-y-1">
                  {s.packs.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs">
                      <span className="flex-1">
                        {t("wa.packMessages", { n: p.messages })} · {money(p.amount)} · {p.createdAt.slice(0, 10)} ·{" "}
                        {p.status === "paid"
                          ? p.paidVia === "online"
                            ? t("wa.pack.paidOnline")
                            : t("wa.pack.paid")
                          : p.status === "void"
                            ? t("wa.pack.void")
                            : t("wa.pack.due")}
                      </span>
                      {p.status === "due" && s.canPayOnline && (
                        <button disabled={busy} onClick={() => act({ action: "pay", packId: p.id })} className="font-semibold text-teal-700 underline">
                          {t("wa.payOnline")}
                        </button>
                      )}
                      {p.status === "due" && isOwner && (
                        <>
                          <button disabled={busy} onClick={() => act({ action: "markPaid", packId: p.id })} className="text-teal-700 underline">
                            {t("wa.markPaid")}
                          </button>
                          <button disabled={busy} onClick={() => act({ action: "void", packId: p.id })} className="text-slate-500 underline">
                            {t("wa.void")}
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {isOwner && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act({ action: "grant", messages: Number(grant) }).then(() => setGrant(""));
                  }}
                  className="flex items-center gap-2 text-xs"
                >
                  <input
                    value={grant}
                    onChange={(e) => setGrant(e.target.value)}
                    inputMode="numeric"
                    placeholder="50"
                    aria-label={t("wa.messagesToGive")}
                    className="w-20 rounded-md border border-slate-300 px-2 py-1"
                  />
                  <button disabled={busy} className="text-teal-700 underline">
                    {t("wa.give")}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
