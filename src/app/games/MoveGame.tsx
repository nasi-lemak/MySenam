"use client";

import { useCallback, useState } from "react";
import type { T } from "@/lib/i18n";
import type { OpenGame } from "@/lib/games";
import type { Booking } from "@/lib/types";
import { formatMinute } from "@/lib/interval";
import { ChangeTime } from "@/components/ChangeTime";

type Act = (url: string, body: object, done?: string) => Promise<void>;
const span = (x: { date: string; startMin: number; endMin: number }, locale: string) => `${x.date} ${formatMinute(x.startMin, locale)}–${formatMinute(x.endMin, locale)}`;
const small = "rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium hover:border-teal-500";
/** A moment as this browser's clock reads it. */
export const localTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";

/**
 * A host moving their game to another time (lib/game-moves.ts): the times
 * its booking could move to, what a move would do, and then a move at once
 * (nobody in it yet) or a new time proposed to its players. While one waits,
 * the host sees who is still to answer and can withdraw it.
 */
export function HostMove({ t, g, act, done }: { t: T; g: OpenGame; act: Act; done: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const optionsUrl = useCallback((day: string) => `/api/games/${g.id}/move?date=${day}`, [g.id]);
  const post = (body: object) =>
    fetch(`/api/games/${g.id}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  if (g.move?.status === "pending")
    return (
      <div className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900" data-testid={`move-waiting-${g.id}`}>
        {t("move.waiting", {
          when: span(g.move.to, t.locale),
          court: g.move.to.courtName,
          n: g.move.waitingFor,
          until: localTime(g.move.expiresAt),
        })}{" "}
        <button onClick={() => void act(`/api/games/${g.id}/move`, { action: "withdraw" })} className={small}>
          {t("move.withdraw")}
        </button>
      </div>
    );
  return (
    <div className="mt-2">
      {g.move?.kind === "venue" && g.move.waitingFor > 0 && (
        <p className="mb-1 text-xs text-amber-900">{t("move.venueWaiting", { reason: g.move.reason ?? "", n: g.move.waitingFor })}</p>
      )}
      {open ? (
        <ChangeTime
          booking={
            // What the picker needs of the game's booking: its code, day and length.
            { code: g.bookingCode, date: g.date, startMin: Math.round(g.startHour * 60), endMin: Math.round(g.endHour * 60), courtId: -1, paymentStatus: "unpaid" } as unknown as Booking
          }
          optionsUrl={optionsUrl}
          preview={(o, day) => post({ date: day, start: o.startMin, courtId: o.courtId, preview: true })}
          submit={(o, day) => post({ date: day, start: o.startMin, courtId: o.courtId })}
          onDone={(_, message) => {
            setOpen(false);
            done(message);
          }}
          onClose={() => setOpen(false)}
        />
      ) : (
        <button onClick={() => setOpen(true)} className={small} data-testid={`move-game-${g.id}`}>
          {t("move.change")}
        </button>
      )}
    </div>
  );
}

/** A player in a game being moved: keep their place at the new time, or leave (their share refunded). */
export function PlayerMove({ t, g, act }: { t: T; g: OpenGame; act: Act }) {
  if (!g.move || !g.mine?.toConfirm) return null;
  const m = g.move;
  return (
    <div className="basis-full rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900" data-testid={`move-asked-${g.id}`}>
      <p>
        {m.kind === "proposal"
          ? t("move.asked", { host: g.hostName, when: span(m.to, t.locale), court: m.to.courtName })
          : t("move.venueMoved", { from: span(m.from, t.locale), reason: m.reason ?? "" })}
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        <button
          onClick={() => void act(`/api/games/${g.id}`, { action: "keepPlace" })}
          className="rounded-md bg-teal-600 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-700"
        >
          {m.kind === "proposal" ? t("move.keep") : t("move.stillComing")}
        </button>
        <button onClick={() => void act(`/api/games/${g.id}`, { action: "leave" })} className={small}>
          {t("move.leave")}
        </button>
      </div>
    </div>
  );
}
