"use client";

import { useState } from "react";
import { useT } from "@/components/Language";
import { LOCALE_NAMES, offeredLocales, type Locale } from "@/lib/i18n";
import type { ManagedVenue } from "./shared";
import { useStaffClock, useStaffT } from "./StaffLanguage";
import { PhoneCheckAdvice } from "./PhoneCheckAdvice";
import { startingLanguage } from "./WaitlistJoin";

type Flag = "counter-shortcut" | "reported" | "exception" | "in-person-agreement";
const CATEGORIES = ["custody_dispute", "guardian_unavailable", "safeguarding"] as const;
type ConsentHow = "online" | "guardian_code" | "staff_assisted_phone_code" | "staff_in_person";
type Purpose = "agree" | "withdraw" | "verify";

interface Request {
  id: number;
  status: "invited" | "awaiting_consent" | "expired";
  initiatedBy: string;
  proposedName: string | null;
  acceptedName: string | null;
  relationship: "parent" | "guardian" | "other" | null;
  consentPossible: boolean;
  /** A guardian recorded by name and number could agree through staff (lib/contact-guardians.ts). */
  contactConsent?: boolean;
  agreed?: { by: string; how: ConsentHow } | null;
  exception: { category: (typeof CATEGORIES)[number]; reviewOn: string } | null;
}

interface Guardian {
  id: number;
  name: string;
  relationship: "parent" | "guardian" | "other";
  provenance: "online" | "counter" | "staff_review";
  account: boolean;
  suspended: boolean;
  review: Flag | null;
  reviewNote: string | null;
  reviewDue?: boolean;
  contactVerified?: boolean;
  claimed?: boolean;
}

interface Found {
  id: number;
  displayName: string;
  birthYear: number | null;
  linked: boolean;
  guardians: Guardian[];
  requests: Request[];
  noticeTasks?: { id: number; guardianName: string; change: "added" | "ended" | "request" | "claimed"; why: string }[];
}

const EMPTY_EXCEPTION = { category: "guardian_unavailable", reason: "", reviewOn: "", suppressNotice: false };

/**
 * Participants a venue knows, and who acts for them (ADR 0023): found by a
 * guardian's number, as the counter finds them, or (managers) by what waits
 * for review; no browsing. A manager ends, pauses or keeps a guardian's
 * relationship, links the participant's own login named by its email,
 * decides the requests waiting and records the narrow exception
 * (`PATCH /api/admin/participants/[id]`); front desk and managers invite
 * another adult as a guardian (a code for their own account; nothing
 * granted until an existing guardian agrees or the manager records an
 * exception). For a guardian the venue recorded by name and number only
 * (lib/contact-guardians.ts), front desk or a manager sends a one-time code
 * to the number recorded for them and enters it as they read it back (their
 * agreement to a request, their own relationship ended, or their number
 * checked), gives them a code to take the relationship over with an account,
 * reports a mistake for them, and marks them told of a change; a manager
 * records an agreement given in person where no code can be sent. Each with
 * who and why in the participant's history and the activity log. The
 * platform owner also sees everything waiting for review, at every venue
 * and for participants no venue knows.
 */
export function ParticipantsPanel({ venues, role = "manager", owner = false }: { venues: ManagedVenue[]; role?: "manager" | "desk"; owner?: boolean }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const manager = role !== "desk";
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [lastLook, setLastLook] = useState<"phone" | "review" | "everywhere">("phone");
  const [codesPossible, setCodesPossible] = useState(true);
  const [claimsPossible, setClaimsPossible] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm";
  const ready = phone.replace(/\D/g, "").length >= 7;
  // In the platform owner's review of every venue, corrections are the owner's ({ owner: true }); the counter's actions need a venue.
  const everywhere = lastLook === "everywhere";
  // Inviting another adult (lib/guardian-requests.ts requestAtVenue): the code is shown once.
  const [invitingFor, setInvitingFor] = useState<number | null>(null);
  const [invitee, setInvitee] = useState({ proposedName: "", email: "" });
  const [made, setMade] = useState<{ participantId: number; code: string; expiresAt: string; consentPossible: boolean; contactConsent?: boolean } | null>(null);
  // The exception to a guardian's agreement, on one request.
  const [excepting, setExcepting] = useState<number | null>(null);
  const [exception, setException] = useState(EMPTY_EXCEPTION);
  // A code sent to a guardian recorded by name and number, waiting to be read back (lib/contact-guardians.ts).
  const [awaiting, setAwaiting] = useState<{ participantId: number; guardian: Guardian; purpose: Purpose; requestId?: number } | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [claimMade, setClaimMade] = useState<{ guardianId: number; code: string; expiresAt: string } | null>(null);
  const [reporting, setReporting] = useState<{ participantId: number; reporter: Guardian; target: number | null; note: string } | null>(null);
  // The language the code's message goes in: staff choose, starting from the language they read the site in (as the waiting-list counter form does).
  const offered = offeredLocales();
  const [codeLanguage, setCodeLanguage] = useState<Locale>(startingLanguage(useT().locale, offered));

  async function load(how: "phone" | "review" | "everywhere") {
    setError(null);
    setLastLook(how);
    try {
      const url =
        how === "everywhere"
          ? "/api/admin/participants?review=1"
          : how === "review"
            ? `/api/admin/participants?venueId=${venueId}&review=1`
            : `/api/admin/participants?venueId=${venueId}&phone=${encodeURIComponent(phone)}`;
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setFound(data.participants);
      setCodesPossible(data.codesPossible !== false);
      setClaimsPossible(data.claimsPossible !== false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  async function send(url: string, method: string, body: Record<string, unknown>, done = t("pbk.pp.done")): Promise<Record<string, unknown> | null> {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setNotice(done);
      await load(lastLook);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
      return null;
    }
  }

  const change = async (participantId: number, body: Record<string, unknown>): Promise<boolean> =>
    (await send(`/api/admin/participants/${participantId}`, "PATCH", everywhere ? { owner: true, ...body } : { venueId, ...body })) !== null;

  const contact = (participantId: number, body: Record<string, unknown>, done?: string) =>
    send(`/api/admin/participants/${participantId}/contact-guardians`, "POST", { venueId, ...body }, done);

  function revoke(p: Found, g: Guardian) {
    const reason = window.prompt(t("pbk.pp.revokeReason", { guardian: g.name, name: p.displayName }));
    if (reason === null) return;
    void change(p.id, { action: "revokeGuardian", guardianId: g.id, reason });
  }

  function review(p: Found, g: Guardian, action: "suspendGuardian" | "confirmGuardian") {
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

  /** A one-time code to the number recorded for them: the code and this venue's name, nothing about the child. */
  async function sendCode(p: Found, g: Guardian, purpose: Purpose, requestId?: number) {
    if (purpose === "withdraw" && !window.confirm(t("gw5.pp.withdrawConfirm", { guardian: g.name, name: p.displayName }))) return;
    const data = await contact(
      p.id,
      { action: "sendCode", guardianId: g.id, purpose, locale: codeLanguage, ...(requestId ? { requestId } : {}) },
      t("gw5.pp.codeSent", { guardian: g.name })
    );
    if (data) {
      setAwaiting({ participantId: p.id, guardian: g, purpose, requestId });
      setCodeInput("");
    }
  }

  async function enterCode() {
    if (!awaiting) return;
    const data = await contact(awaiting.participantId, {
      action: "confirmCode",
      guardianId: awaiting.guardian.id,
      purpose: awaiting.purpose,
      code: codeInput,
      ...(awaiting.requestId ? { requestId: awaiting.requestId } : {}),
    });
    if (data) setAwaiting(null);
  }

  function inPerson(p: Found, g: Guardian, r: Request) {
    const reason = window.prompt(t("gw5.pp.inPersonReason", { guardian: g.name }));
    if (reason === null) return;
    void contact(p.id, { action: "inPerson", guardianId: g.id, requestId: r.id, reason });
  }

  async function claimCode(p: Found, g: Guardian) {
    const data = await contact(p.id, { action: "claimCode", guardianId: g.id });
    if (data) setClaimMade({ guardianId: g.id, code: String(data.code), expiresAt: String(data.expiresAt) });
  }

  async function report() {
    if (!reporting || reporting.target === null) return;
    const data = await contact(reporting.participantId, { action: "report", reporterId: reporting.reporter.id, guardianId: reporting.target, note: reporting.note });
    if (data) setReporting(null);
  }

  async function told(taskId: number) {
    await send("/api/admin/attention", "POST", { action: "guardianTold", taskId, how: "told" });
  }

  const requestLine = (r: Request) => {
    const who = r.acceptedName ?? r.proposedName ?? "";
    if (r.status === "awaiting_consent") return t("gv.pp.req.awaiting", { who, relationship: t(`apr.child.rel.${r.relationship ?? "other"}`) });
    return t(r.status === "expired" ? "gv.pp.req.expired" : "gv.pp.req.invited", { who, by: r.initiatedBy });
  };
  const flagText = (f: Flag) => (f === "in-person-agreement" ? t("gw5.pp.flag.inPerson") : t(`gv.pp.flag.${f}`));
  // A guardian recorded by name and number, standing, not taken over by an account: staff act for them through a code.
  const recorded = (g: Guardian) => !g.account && !g.claimed;
  const link_ = "font-medium text-teal-700 underline";

  return (
    <section>
      <h2 className="text-lg font-bold">{t("pbk.pp.title")}</h2>
      <p className="mt-1 text-sm text-slate-500">
        {t("pbk.pp.intro")} {t("gv.pp.intro")} {t("gw5.pp.intro")}
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
        {manager && (
          <button type="button" onClick={() => void load("review")} className="text-sm font-medium text-teal-700 underline">
            {t("gv.pp.reviewList")}
          </button>
        )}
        {owner && (
          <button type="button" onClick={() => void load("everywhere")} className="text-sm font-medium text-teal-700 underline">
            {t("gw5.pp.ownerReview")}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}
      {found !== null && !codesPossible && !everywhere && <p className="mt-2 text-xs text-amber-700">{t("gw5.pp.noCodes")}</p>}
      {found !== null && !claimsPossible && !everywhere && (
        <div className="mt-2">
          <PhoneCheckAdvice on={false} where="guardians" />
        </div>
      )}
      {found !== null && found.length > 0 && codesPossible && !everywhere && offered.length > 1 && (
        <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          {t("fin5.pp.codeLanguage")}
          <select value={codeLanguage} onChange={(e) => setCodeLanguage(e.target.value as Locale)} className={input}>
            {offered.map((code) => (
              <option key={code} value={code}>
                {LOCALE_NAMES[code]}
              </option>
            ))}
          </select>
        </label>
      )}
      {found !== null && found.length === 0 && <p className="mt-2 text-sm text-slate-500">{t(lastLook === "phone" ? "pbk.pp.none" : "gv.pp.reviewNone")}</p>}
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
                    {g.review && <span className="rounded bg-amber-50 px-1 text-amber-800">{flagText(g.review)}</span>}
                    {g.reviewDue && <span className="rounded bg-amber-50 px-1 text-amber-800">{t("gw5.pp.reviewDue")}</span>}
                    {g.claimed && <span className="text-slate-500">{t("gw5.pp.claimed")}</span>}
                    {recorded(g) && <span className="text-slate-500">{t(g.contactVerified ? "gw5.pp.verified" : "gw5.pp.unverified")}</span>}
                    {g.reviewNote && <span className="text-slate-500">({g.reviewNote})</span>}
                    {manager && !g.suspended && (
                      <button type="button" onClick={() => review(p, g, "suspendGuardian")} className="font-medium text-amber-700 underline">
                        {t("gv.pp.suspend")}
                      </button>
                    )}
                    {manager && (g.suspended || g.review || g.reviewDue) && (
                      <button type="button" onClick={() => review(p, g, "confirmGuardian")} className={link_}>
                        {t("gv.pp.confirm")}
                      </button>
                    )}
                    {manager && (
                      <button type="button" onClick={() => revoke(p, g)} className="font-medium text-red-700 underline">
                        {t("pbk.pp.revoke")}
                      </button>
                    )}
                    {recorded(g) && !everywhere && (
                      <>
                        {codesPossible && !g.contactVerified && !g.suspended && (
                          <button type="button" onClick={() => void sendCode(p, g, "verify")} className={link_}>
                            {t("gw5.pp.verify")}
                          </button>
                        )}
                        {codesPossible && (
                          <button type="button" onClick={() => void sendCode(p, g, "withdraw")} className="font-medium text-red-700 underline">
                            {t("gw5.pp.withdraw")}
                          </button>
                        )}
                        {claimsPossible && !g.suspended && (
                          <button type="button" onClick={() => void claimCode(p, g)} className={link_}>
                            {t("gw5.pp.claim")}
                          </button>
                        )}
                        {!g.suspended && p.guardians.length > 1 && (
                          <button type="button" onClick={() => setReporting({ participantId: p.id, reporter: g, target: null, note: "" })} className={link_}>
                            {t("gw5.pp.report")}
                          </button>
                        )}
                      </>
                    )}
                    {claimMade?.guardianId === g.id && (
                      <span role="status" className="block w-full rounded border border-emerald-200 bg-emerald-50 p-2 text-emerald-900">
                        {t("gw5.pp.claimMade", { guardian: g.name, code: claimMade.code, date: clock.day(claimMade.expiresAt, venueId) })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {reporting?.participantId === p.id && (
                <div className="mt-2 space-y-2 rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs">
                  <select
                    aria-label={t("gw5.pp.reportTarget", { guardian: reporting.reporter.name })}
                    value={reporting.target ?? ""}
                    onChange={(e) => setReporting({ ...reporting, target: e.target.value ? Number(e.target.value) : null })}
                    className={input}
                  >
                    <option value="">{t("gw5.pp.reportTarget", { guardian: reporting.reporter.name })}</option>
                    {p.guardians
                      .filter((o) => o.id !== reporting.reporter.id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                  </select>
                  <input
                    aria-label={t("gw5.pp.reportNote")}
                    placeholder={t("gw5.pp.reportNote")}
                    value={reporting.note}
                    onChange={(e) => setReporting({ ...reporting, note: e.target.value })}
                    className={`w-full ${input}`}
                  />
                  <div className="flex gap-3">
                    <button type="button" disabled={reporting.target === null} onClick={() => void report()} className="rounded-md bg-teal-600 px-3 py-1 font-semibold text-white disabled:bg-slate-300">
                      {t("gw5.pp.reportSave")}
                    </button>
                    <button type="button" onClick={() => setReporting(null)} className="text-slate-600 underline">
                      {t("pbk2.g.cancel")}
                    </button>
                  </div>
                </div>
              )}
              {awaiting?.participantId === p.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs">
                  <span>{t("gw5.pp.codeSent", { guardian: awaiting.guardian.name })}</span>
                  <input
                    aria-label={t("gw5.pp.codeLabel")}
                    placeholder={t("gw5.pp.codeLabel")}
                    inputMode="numeric"
                    maxLength={8}
                    value={codeInput}
                    onChange={(e) => setCodeInput(e.target.value)}
                    className={`w-32 ${input}`}
                  />
                  <button type="button" onClick={() => void enterCode()} className="rounded-md bg-teal-600 px-3 py-1 font-semibold text-white hover:bg-teal-700">
                    {t("gw5.pp.codeEnter")}
                  </button>
                  <button type="button" onClick={() => setAwaiting(null)} className="text-slate-600 underline">
                    {t("pbk2.g.cancel")}
                  </button>
                </div>
              )}
              {(p.noticeTasks ?? []).map((task) => (
                <div key={task.id} className="mt-1 flex flex-wrap items-center gap-2 text-xs text-amber-800">
                  {t("gw5.pp.untold", { guardian: task.guardianName, change: t(`gw5.att.change.${task.change}`) })}
                  <button type="button" onClick={() => void told(task.id)} className={link_}>
                    {t("gw5.att.told")}
                  </button>
                </div>
              ))}
              {p.requests.length > 0 && (
                <div className="mt-2 text-xs">
                  <p className="font-medium text-slate-600">{t("gv.pp.requests")}</p>
                  <ul className="mt-1 space-y-1">
                    {p.requests.map((r) => (
                      <li key={r.id} className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-slate-600">
                          {requestLine(r)}
                          {r.agreed && <span className="text-slate-500">{t("gw5.pp.agreedBy", { who: r.agreed.by, how: t(`gw5.pp.how.${r.agreed.how}`) })}</span>}
                          {r.status === "awaiting_consent" && !r.consentPossible && !r.contactConsent && !r.agreed && (
                            <span className="text-amber-700">{t("gv.pp.req.noConsent")}</span>
                          )}
                          {r.exception && (
                            <span className="text-slate-500">
                              {t("gv.pp.req.exception", { category: t(`gv.pp.exc.${r.exception.category}`), date: r.exception.reviewOn })}
                            </span>
                          )}
                          {manager && !r.exception && r.status !== "expired" && excepting !== r.id && (
                            <button type="button" onClick={() => setExcepting(r.id)} className={link_}>
                              {t("gv.pp.exception")}
                            </button>
                          )}
                          {manager && (
                            <button type="button" onClick={() => closeRequest(p, r)} className="font-medium text-red-700 underline">
                              {t("gv.pp.close")}
                            </button>
                          )}
                        </div>
                        {r.contactConsent && !r.agreed && r.status !== "expired" && !everywhere && (
                          <div className="flex flex-wrap gap-3">
                            {p.guardians
                              .filter((g) => recorded(g) && !g.suspended)
                              .map((g) =>
                                codesPossible ? (
                                  <button key={g.id} type="button" onClick={() => void sendCode(p, g, "agree", r.id)} className={link_}>
                                    {t("gw5.pp.askAgree", { guardian: g.name })}
                                  </button>
                                ) : manager ? (
                                  <button key={g.id} type="button" onClick={() => inPerson(p, g, r)} className={link_}>
                                    {t("gw5.pp.inPerson", { guardian: g.name })}
                                  </button>
                                ) : null
                              )}
                          </div>
                        )}
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
              {manager && !p.linked && !everywhere && (
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
                      date: clock.day(made.expiresAt, venueId),
                      name: p.displayName,
                    })}
                  </p>
                  {!made.consentPossible && (
                    <p className="text-amber-800">{t(made.contactConsent ? "gw5.g.contactConsent" : "gv.g.noConsent", { name: p.displayName })}</p>
                  )}
                </div>
              )}
              {everywhere ? null : invitingFor !== p.id ? (
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
