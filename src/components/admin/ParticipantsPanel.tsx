"use client";

import { useState } from "react";
import type { ManagedVenue } from "./shared";
import { useStaffT } from "./StaffLanguage";

interface Found {
  id: number;
  displayName: string;
  birthYear: number | null;
  linked: boolean;
  guardians: { id: number; name: string; relationship: "parent" | "guardian" | "other"; provenance: "online" | "counter" | "staff_review"; account: boolean }[];
}

/**
 * A manager's corrections to a participant this venue knows (ADR 0023;
 * `PATCH /api/admin/participants/[id]`): end a guardian's relationship, or
 * link the participant's own login named by its email, each with a reason
 * kept in the participant's history and the activity log. Found only by a
 * guardian's number, as the counter finds them: no browsing.
 */
export function ParticipantsPanel({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm";
  const ready = phone.replace(/\D/g, "").length >= 7;

  async function look() {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/participants?venueId=${venueId}&phone=${encodeURIComponent(phone)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setFound(data.participants);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  async function change(participantId: number, body: Record<string, unknown>) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/participants/${participantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setNotice(t("pbk.pp.done"));
      await look();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  function revoke(p: Found, g: Found["guardians"][number]) {
    const reason = window.prompt(t("pbk.pp.revokeReason", { guardian: g.name, name: p.displayName }));
    if (reason === null) return;
    void change(p.id, { action: "revokeGuardian", guardianId: g.id, reason });
  }

  function link(p: Found) {
    const email = window.prompt(t("pbk.pp.linkEmail", { name: p.displayName }));
    if (email === null) return;
    const reason = window.prompt(t("pbk.pp.linkReason"));
    if (reason === null) return;
    void change(p.id, { action: "link", email, reason });
  }

  return (
    <section>
      <h2 className="text-lg font-bold">{t("pbk.pp.title")}</h2>
      <p className="mt-1 text-sm text-slate-500">{t("pbk.pp.intro")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {venues.length > 1 && (
          <select aria-label={t("c.venue")} value={venueId} onChange={(e) => setVenueId(Number(e.target.value))} className={input}>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
        <input aria-label={t("pbk.pp.phone")} placeholder={t("pbk.pp.phone")} value={phone} onChange={(e) => setPhone(e.target.value)} className={input} />
        <button
          type="button"
          disabled={!ready}
          onClick={() => void look()}
          className="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:bg-slate-300"
        >
          {t("pbk.pp.look")}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}
      {found !== null && found.length === 0 && <p className="mt-2 text-sm text-slate-500">{t("pbk.pp.none")}</p>}
      {found !== null && found.length > 0 && (
        <ul className="mt-3 space-y-2">
          {found.map((p) => (
            <li key={p.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <div className="font-medium">
                {p.displayName}
                {p.birthYear ? ` · ${t("ptc.pick.born", { year: p.birthYear })}` : ""}
                {p.linked ? ` · ${t("pbk.pp.linked")}` : ""}
              </div>
              <ul className="mt-1 space-y-1">
                {p.guardians.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    {t("pbk.pp.guardian", { name: g.name, relationship: t(`apr.child.rel.${g.relationship}`), how: t(`pbk.pp.how.${g.provenance}`) })}
                    <button type="button" onClick={() => revoke(p, g)} className="font-medium text-red-700 underline">
                      {t("pbk.pp.revoke")}
                    </button>
                  </li>
                ))}
              </ul>
              {!p.linked && (
                <button type="button" onClick={() => link(p)} className="mt-1 text-xs font-medium text-teal-700 underline">
                  {t("pbk.pp.link")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
