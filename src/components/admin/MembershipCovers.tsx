"use client";

import { readJson } from "@/lib/read-response";
import { useStaffMay } from "./StaffMay";
import { useState } from "react";
import type { Membership } from "@/lib/types";
import type { CoverChangeView, CoverPlaces } from "@/lib/membership-purchases";
import { ParticipantPicker, type PickedParticipant } from "./ParticipantPicker";
import { useStaffClock, useStaffT } from "./StaffLanguage";

const CHANGE_PHRASES = {
  named: "mb6.cr.named",
  added: "mb6.cr.added",
  removed: "mb6.cr.removed",
  corrected_out: "mb6.cr.correctedOut",
  corrected_in: "mb6.cr.correctedIn",
} as const;

/**
 * Who a membership covered when (lib/membership-purchases.ts `coverHistory`):
 * every change, by whom and why, and a family term's places. A manager
 * corrects a person entered wrongly here, with a reason (`correctCover`):
 * it uses none of the term's places, and goes in the activity log.
 */
export function MembershipCovers({ membership, venueId, onChanged }: { membership: Membership; venueId: number; onChanged: () => void }) {
  const t = useStaffT();
  // Correcting who is covered is a manager's (lib/roles.ts): the desk reads the history.
  const mayCorrect = useStaffMay()("membershipCovers");
  const clock = useStaffClock();
  const [changes, setChanges] = useState<CoverChangeView[] | null>(null);
  const [places, setPlaces] = useState<CoverPlaces | null>(null);
  const [remove, setRemove] = useState<number>(membership.covers?.[0]?.id ?? 0);
  const [add, setAdd] = useState<PickedParticipant | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function load() {
    const res = await fetch(`/api/admin/memberships/${membership.id}/covers`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await readJson(res);
    setChanges(data.changes);
    setPlaces(data.places);
  }

  async function correct(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    const res = await fetch(`/api/admin/memberships/${membership.id}/covers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remove, ...(add ? { add: add.id } : {}), reason }),
    });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("mb6.cr.correctFailed")));
    setDone(true);
    setAdd(null);
    setReason("");
    await load();
    onChanged();
  }

  const covers = membership.covers ?? [];
  return (
    <details
      className="mt-1 text-xs"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open && changes === null) void load();
      }}
    >
      <summary className="cursor-pointer text-slate-500">{t("mb6.cr.history")}</summary>
      {changes === null ? (
        <p className="text-slate-400">{t("c.loading")}</p>
      ) : (
        <ul className="mt-1 space-y-0.5 whitespace-normal text-slate-600">
          {changes.map((c, i) => (
            <li key={i}>
              {clock.day(c.at, venueId)} · {t(CHANGE_PHRASES[c.change], { name: c.name ?? t("mb6.cr.someone") })}
              {c.by && ` · ${t("mb6.cr.by", { name: c.by })}`}
              {c.reason && ` · ${c.reason}`}
            </li>
          ))}
        </ul>
      )}
      {places && <p className="mt-1 text-slate-500">{t("mb6.cr.places", { used: places.used, total: places.limit + places.swaps })}</p>}
      {covers.length > 0 && mayCorrect && (
        <form onSubmit={correct} className="mt-2 flex flex-wrap items-end gap-2 whitespace-normal">
          <span className="w-full font-medium text-slate-600">{t("mb6.cr.correctTitle")}</span>
          <label className="flex flex-col text-slate-500">
            {t("mb6.cr.takeOff")}
            <select value={remove} onChange={(e) => setRemove(Number(e.target.value))} className="mt-0.5 rounded border border-slate-300 px-1 py-0.5">
              {covers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col text-slate-500">
            {t("mb6.cr.putOn")}
            <ParticipantPicker venueId={venueId} phone={membership.holderPhone} guardianName={membership.holderName} value={add} onChange={setAdd} />
          </div>
          <label className="flex flex-col text-slate-500">
            {t("mb6.cr.reason")}
            <input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-0.5 w-56 rounded border border-slate-300 px-1 py-0.5" />
          </label>
          <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50">
            {t("mb6.cr.correct")}
          </button>
          {error && <span className="w-full font-medium text-red-700">{error}</span>}
          {done && <span className="w-full text-emerald-700">{t("mb6.cr.corrected")}</span>}
        </form>
      )}
    </details>
  );
}
