"use client";

import { useCallback, useEffect, useState } from "react";
import type { Pack } from "@/lib/whatsapp-credit";
import type { Usage } from "@/lib/whatsapp-usage";

interface State {
  on: boolean;
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
 * WhatsApp confirmations for one venue: off unless the venue wants them, and
 * on a marketplace paid for in advance, a pack at a time. Email and the code
 * on screen are always there whatever this says.
 */
export function WhatsAppEditor({ venueId, isOwner }: { venueId: number; isOwner: boolean }) {
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
      if (!res.ok) throw new Error(out.error ?? "Request failed");
      if (typeof out.url === "string") return window.location.assign(out.url);
      setS(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
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
        {open ? "Close WhatsApp" : s?.on ? `WhatsApp confirmations: on${s.prepaid ? ` (${s.balance} left)` : ""}` : "WhatsApp confirmations (optional)"}
      </button>
      {open && s && (
        <div className="mt-2 space-y-3">
          <p className="text-xs text-slate-500">
            Customers always see their booking code on screen, and get it by email with a calendar invite when they give an address — free.
            WhatsApp is extra: the confirmation also goes to their phone.
            {s.prepaid &&
              ` It is paid for in advance: ${s.pack.messages} messages for RM${s.pack.price}, one message per confirmation, cancellation or waitlist offer. When they run out, WhatsApp simply stops and email carries on; you are emailed at 20 left and at none.`}
          </p>
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
          {!s.available ? (
            <p className="text-xs text-amber-700">WhatsApp is not set up on this site yet.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                disabled={busy}
                onClick={() => act({ action: s.on ? "off" : "on" })}
                aria-pressed={s.on}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${s.on ? "bg-teal-600 text-white" : "border border-slate-300 text-slate-700"} disabled:opacity-50`}
              >
                {s.on ? "On — turn off" : "Turn on"}
              </button>
              {s.prepaid && (
                <span className={`text-xs ${s.balance === 0 && s.on ? "font-semibold text-amber-700" : "text-slate-600"}`}>
                  {s.balance} messages left{s.balance === 0 && s.on ? " — nothing goes on WhatsApp until you buy more" : ""}
                </span>
              )}
              {s.on && (
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={s.reminders}
                    disabled={busy}
                    onChange={(e) => act({ action: e.target.checked ? "remindersOn" : "remindersOff" })}
                  />
                  Day-before reminders on WhatsApp too (one message each; email reminders always go)
                </label>
              )}
              <span className="text-xs text-slate-500">
                This month: {s.usage.paid} sent{s.usage.free > 0 ? `, ${s.usage.free} as replies in chats customers opened` : ""}
              </span>
            </div>
          )}

          {s.prepaid && s.available && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  disabled={busy}
                  onClick={() => act({ action: "buy" })}
                  className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  Buy {s.pack.messages} messages · RM{s.pack.price}
                </button>
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  Bookings a month
                  <input
                    value={bookings}
                    onChange={(e) => setBookings(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    placeholder="e.g. 500"
                    aria-label="Bookings a month"
                    className="w-20 rounded-md border border-slate-300 px-2 py-1"
                  />
                </label>
                {perMonth > 0 && (
                  <span className="text-xs text-slate-600" data-testid="estimate">
                    ≈ {perMonth} messages a month: {packsNeeded} pack{packsNeeded === 1 ? "" : "s"}, about RM
                    {(packsNeeded * s.pack.price).toFixed(2)}
                  </span>
                )}
              </div>
              {s.packs.length > 0 && (
                <ul className="space-y-1">
                  {s.packs.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs">
                      <span className="flex-1">
                        {p.messages} messages · RM{p.amount} · {p.createdAt.slice(0, 10)} ·{" "}
                        {p.status === "paid" ? `paid${p.paidVia === "online" ? " online" : ""}` : p.status === "void" ? "void" : "waiting for payment"}
                      </span>
                      {p.status === "due" && s.canPayOnline && (
                        <button disabled={busy} onClick={() => act({ action: "pay", packId: p.id })} className="font-semibold text-teal-700 underline">
                          Pay online
                        </button>
                      )}
                      {p.status === "due" && isOwner && (
                        <>
                          <button disabled={busy} onClick={() => act({ action: "markPaid", packId: p.id })} className="text-teal-700 underline">
                            Mark paid
                          </button>
                          <button disabled={busy} onClick={() => act({ action: "void", packId: p.id })} className="text-slate-500 underline">
                            Void
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
                    aria-label="Messages to give"
                    className="w-20 rounded-md border border-slate-300 px-2 py-1"
                  />
                  <button disabled={busy} className="text-teal-700 underline">
                    Give messages (trial, goodwill)
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
