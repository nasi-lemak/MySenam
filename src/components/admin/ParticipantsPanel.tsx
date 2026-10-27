"use client";

import { useState } from "react";
import type { ManagedVenue } from "./shared";
import { useStaffT } from "./StaffLanguage";

type Flag = "counter-shortcut" | "reported" | "exception";
const CATEGORIES = ["custody_dispute", "guardian_unavailable", "safeguarding"] as const;

interface Request {
  id: number;
  status: "invited" | "awaiting_consent" | "expired";
  initiatedBy: string;
  proposedName: string | null;
  acceptedName: string | null;
  relationship: "parent" | "guardian" | "other" | null;
  consentPossible: boolean;
  exception: { category: (typeof CATEGORIES)[number]; reviewOn: string } | null;
}

interface Found {
  id: number;
  displayName: string;
  birthYear: number | null;
  linked: boolean;
  guardians: {
    id: number;
    name: string;
    relationship: "parent" | "guardian" | "other";
    provenance: "online" | "counter" | "staff_review";
    account: boolean;
    suspended: boolean;
    review: Flag | null;
    reviewNote: string | null;
  }[];
  requests: Request[];
}

const EMPTY_EXCEPTION = { category: "guardian_unavailable", reason: "", reviewOn: "", suppressNotice: false };

/**
 * A manager's corrections to a participant this venue knows (ADR 0023;
 * `PATCH /api/admin/participants/[id]`): end, pause or keep a guardian's
 * relationship, link the participant's own login named by its email, invite
 * another adult as a guardian (a code for their own account; nothing granted
 * until an existing guardian agrees or the manager records an exception),
 * and decide the requests waiting; each with a reason kept in the
 * participant's history and the activity log. Found by a guardian's number,
 * as the counter finds them, or by what waits for a manager's review: no
 * browsing.
 */
export function ParticipantsPanel({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [lastLook, setLastLook] = useState<"phone" | "review">("phone");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm";
  const ready = phone.replace(/\D/g, "").length >= 7;
  // Inviting another adult (lib/guardian-requests.ts requestAtVenue): the code is shown once.
  const [invitingFor, setInvitingFor] = useState<number | null>(null);
  const [invitee, setInvitee] = useState({ proposedName: "", email: "" });
  const [made, setMade] = useState<{ participantId: number; code: string; expiresAt: string; consentPossible: boolean } | null>(null);
  // The exception to a guardian's agreement, on one request.
  const [excepting, setExcepting] = useState<number | null>(null);
  const [exception, setException] = useState(EMPTY_EXCEPTION);

  async function load(how: "phone" | "review") {
    setError(null);
    setLastLook(how);
    try {
      const url = how === "review" ? `/api/admin/participants?venueId=${venueId}&review=1` : `/api/admin/participants?venueId=${venueId}&phone=${encodeURIComponent(phone)}`;
      const res = await fetch(url, { cache: "no-store" });
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
      await load(lastLook);
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

  function review(p: Found, g: Found["guardians"][number], action: "suspendGuardian" | "confirmGuardian") {
    const reason = window.prompt(t(action === "suspendGuardian" ? "gv.pp.suspendReason" : "gv.pp.confirmReason", { guardian: g.name, name: p.displayName }));
    if (reason === null) return;
    void change(p.id, { action, guardianId: g.id, reason });
  }

  function closeRequest(p: Found, r: Request) {
    const reason = window.prompt(t("gv.pp.closeReason"));
    if (reason === null) return;
    void change(p.id, { action: "closeRequest", requestId: r.id, reason });
  }

  async function recordException(p: Found, r: Request) {
    if (!(await change(p.id, { action: "exception", requestId: r.id, ...exception }))) return;
    setExcepting(null);
    setException(EMPTY_EXCEPTION);
  }

  async function invite(p: Found) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/participants/${p.id}/guardians`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, proposedName: invitee.proposedName, ...(invitee.email.trim() ? { email: invitee.email.trim() } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setMade({ participantId: p.id, ...data.request });
      setInvitingFor(null);
      await load(lastLook);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  function link(p: Found) {
    const email = window.prompt(t("pbk.pp.linkEmail", { name: p.displayName }));
    if (email === null) return;
    const reason = window.prompt(t("pbk.pp.linkReason"));
    if (reason === null) return;
    void change(p.id, { action: "link", email, reason });
  }

  const requestLine = (r: Request) => {
    const who = r.acceptedName ?? r.proposedName ?? "";
    if (r.status === "awaiting_consent") return t("gv.pp.req.awaiting", { who, relationship: t(`apr.child.rel.${r.relationship ?? "other"}`) });
    return t(r.status === "expired" ? "gv.pp.req.expired" : "gv.pp.req.invited", { who, by: r.initiatedBy });
  };

  return (
    <section>
      <h2 className="text-lg font-bold">{t("pbk.pp.title")}</h2>
      <p className="mt-1 text-sm text-slate-500">
        {t("pbk.pp.intro")} {t("gv.pp.intro")}
      </p>
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
          onClick={() => void load("phone")}
          className="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:bg-slate-300"
        >
          {t("pbk.pp.look")}
        </button>
        <button type="button" onClick={() => void load("review")} className="text-sm font-medium text-teal-700 underline">
          {t("gv.pp.reviewList")}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}
      {found !== null && found.length === 0 && <p className="mt-2 text-sm text-slate-500">{t(lastLook === "review" ? "gv.pp.reviewNone" : "pbk.pp.none")}</p>}
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
                    {g.suspended && <span className="rounded bg-amber-100 px-1 text-amber-800">{t("gv.pp.paused")}</span>}
                    {g.review && <span className="rounded bg-amber-50 px-1 text-amber-800">{t(`gv.pp.flag.${g.review}`)}</span>}
                    {g.reviewNote && <span className="text-slate-500">({g.reviewNote})</span>}
                    {!g.suspended && (
                      <button type="button" onClick={() => review(p, g, "suspendGuardian")} className="font-medium text-amber-700 underline">
                        {t("gv.pp.suspend")}
                      </button>
                    )}
                    {(g.suspended || g.review) && (
                      <button type="button" onClick={() => review(p, g, "confirmGuardian")} className="font-medium text-teal-700 underline">
                        {t("gv.pp.confirm")}
                      </button>
                    )}
                    <button type="button" onClick={() => revoke(p, g)} className="font-medium text-red-700 underline">
                      {t("pbk.pp.revoke")}
                    </button>
                  </li>
                ))}
              </ul>
              {p.requests.length > 0 && (
                <div className="mt-2 text-xs">
                  <p className="font-medium text-slate-600">{t("gv.pp.requests")}</p>
                  <ul className="mt-1 space-y-1">
                    {p.requests.map((r) => (
                      <li key={r.id} className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-slate-600">
                          {requestLine(r)}
                          {r.status === "awaiting_consent" && !r.consentPossible && <span className="text-amber-700">{t("gv.pp.req.noConsent")}</span>}
                          {r.exception && (
                            <span className="text-slate-500">
                              {t("gv.pp.req.exception", { category: t(`gv.pp.exc.${r.exception.category}`), date: r.exception.reviewOn })}
                            </span>
                          )}
                          {!r.exception && r.status !== "expired" && excepting !== r.id && (
                            <button type="button" onClick={() => setExcepting(r.id)} className="font-medium text-teal-700 underline">
                              {t("gv.pp.exception")}
                            </button>
                          )}
                          <button type="button" onClick={() => closeRequest(p, r)} className="font-medium text-red-700 underline">
                            {t("gv.pp.close")}
                          </button>
                        </div>
                        {excepting === r.id && (
                          <div className="space-y-2 rounded-lg border border-slate-100 bg-slate-50 p-2">
                            <select
                              aria-label={t("gv.pp.exc.category")}
                              value={exception.category}
                              onChange={(e) => setException({ ...exception, category: e.target.value })}
                              className={input}
                            >
                              {CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {t(`gv.pp.exc.${c}`)}
                                </option>
                              ))}
                            </select>
                            <input
                              aria-label={t("gv.pp.exc.reason")}
                              placeholder={t("gv.pp.exc.reason")}
                              value={exception.reason}
                              onChange={(e) => setException({ ...exception, reason: e.target.value })}
                              className={`w-full ${input}`}
                            />
                            <label className="flex flex-wrap items-center gap-2">
                              {t("gv.pp.exc.reviewOn")}
                              <input type="date" value={exception.reviewOn} onChange={(e) => setException({ ...exception, reviewOn: e.target.value })} className={input} />
                            </label>
                            <label className="flex items-start gap-2">
                              <input
                                type="checkbox"
                                checked={exception.suppressNotice}
                                onChange={(e) => setException({ ...exception, suppressNotice: e.target.checked })}
                                className="mt-0.5"
                              />
                              {t("gv.pp.exc.suppress")}
                            </label>
                            <p className="text-slate-500">{t("gv.pp.exc.note")}</p>
                            <div className="flex gap-3">
                              <button
                                type="button"
                                onClick={() => void recordException(p, r)}
                                className="rounded-md bg-teal-600 px-3 py-1 font-semibold text-white hover:bg-teal-700"
                              >
                                {t("gv.pp.exc.save")}
                              </button>
                              <button type="button" onClick={() => setExcepting(null)} className="text-slate-600 underline">
                                {t("pbk2.g.cancel")}
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!p.linked && (
                <button type="button" onClick={() => link(p)} className="mt-1 text-xs font-medium text-teal-700 underline">
                  {t("pbk.pp.link")}
                </button>
              )}
              {made?.participantId === p.id && (
                <div role="status" className="mt-2 space-y-1 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
                  <p>
                    {t("gv.g.code", {
                      adult: invitee.proposedName || invitee.email,
                      code: made.code,
                      date: new Date(made.expiresAt).toLocaleDateString(),
                      name: p.displayName,
                    })}
                  </p>
                  {!made.consentPossible && <p className="text-amber-800">{t("gv.g.noConsent", { name: p.displayName })}</p>}
                </div>
              )}
              {invitingFor !== p.id ? (
                <button
                  type="button"
                  onClick={() => {
                    setInvitingFor(p.id);
                    setMade(null);
                    setInvitee({ proposedName: "", email: "" });
                  }}
                  className="mt-1 block text-xs font-medium text-teal-700 underline"
                >
                  {t("gv.pp.invite")}
                </button>
              ) : (
                <div className="mt-2 space-y-2 rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs">
                  <div className="flex flex-wrap gap-2">
                    <input
                      aria-label={t("gv.pp.proposedName")}
                      placeholder={t("gv.pp.proposedName")}
                      value={invitee.proposedName}
                      onChange={(e) => setInvitee({ ...invitee, proposedName: e.target.value })}
                      className={`w-full max-w-xs ${input}`}
                    />
                    <input
                      type="email"
                      aria-label={t("gv.pp.email")}
                      placeholder={t("gv.pp.email")}
                      value={invitee.email}
                      onChange={(e) => setInvitee({ ...invitee, email: e.target.value })}
                      className={`w-full max-w-xs ${input}`}
                    />
                  </div>
                  <div className="flex gap-3">
                    <button type="button" onClick={() => void invite(p)} className="rounded-md bg-teal-600 px-3 py-1 font-semibold text-white hover:bg-teal-700">
                      {t("gv.pp.makeCode")}
                    </button>
                    <button type="button" onClick={() => setInvitingFor(null)} className="text-slate-600 underline">
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
