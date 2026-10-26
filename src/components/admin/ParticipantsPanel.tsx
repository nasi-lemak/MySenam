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
 * `PATCH /api/admin/participants/[id]`): end a guardian's relationship,
 * link the participant's own login named by its email, or add a guardian's
 * account on its holder's declaration made in person, each with a reason
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
  // Adding a guardian's account, on its holder's declaration made in person (lib/participants.ts addGuardianAtVenue).
  const [addingFor, setAddingFor] = useState<number | null>(null);
  const [account, setAccount] = useState({ email: "", relationship: "parent", authority: false, reason: "" });

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

  async function change(participantId: number, body: Record<string, unknown>): Promise<boolean> {
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
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
      return false;
    }
  }

  function revoke(p: Found, g: Found["guardians"][number]) {
    const reason = window.prompt(t("pbk.pp.revokeReason", { guardian: g.name, name: p.displayName }));
    if (reason === null) return;
    void change(p.id, { action: "revokeGuardian", guardianId: g.id, reason });
  }

  async function addAccount(p: Found) {
    if (!(await change(p.id, { action: "addGuardian", ...account }))) return;
    setAddingFor(null);
    setAccount({ email: "", relationship: "parent", authority: false, reason: "" });
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
              {addingFor !== p.id ? (
                <button type="button" onClick={() => setAddingFor(p.id)} className="mt-1 block text-xs font-medium text-teal-700 underline">
                  {t("pbk2.pp.addAccount")}
                </button>
              ) : (
                <div className="mt-2 space-y-2 rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs">
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="email"
                      aria-label={t("pbk2.pp.email")}
                      placeholder={t("pbk2.pp.email")}
                      value={account.email}
                      onChange={(e) => setAccount({ ...account, email: e.target.value })}
                      className={`w-full max-w-xs ${input}`}
                    />
                    <select
                      aria-label={t("ptc.pick.relationship")}
                      value={account.relationship}
                      onChange={(e) => setAccount({ ...account, relationship: e.target.value })}
                      className={input}
                    >
                      {(["parent", "guardian", "other"] as const).map((r) => (
                        <option key={r} value={r}>
                          {t("ptc.pick.guardianIs", { relationship: t(`apr.child.rel.${r}`) })}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={account.authority} onChange={(e) => setAccount({ ...account, authority: e.target.checked })} className="mt-0.5" />
                    {t("pbk2.pp.declared", { name: p.displayName })}
                  </label>
                  <input
                    aria-label={t("pbk2.pp.reason")}
                    placeholder={t("pbk2.pp.reason")}
                    value={account.reason}
                    onChange={(e) => setAccount({ ...account, reason: e.target.value })}
                    className={`w-full ${input}`}
                  />
                  <p className="text-slate-500">{t("pbk2.pp.accountNote", { name: p.displayName })}</p>
                  <div className="flex gap-3">
                    <button type="button" onClick={() => void addAccount(p)} className="rounded-md bg-teal-600 px-3 py-1 font-semibold text-white hover:bg-teal-700">
                      {t("pbk2.pp.add")}
                    </button>
                    <button type="button" onClick={() => setAddingFor(null)} className="text-slate-600 underline">
                      {t("pbk2.g.cancel")}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
