"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { Admin } from "@/lib/admin-auth";
import type { ManagedVenue } from "./shared";
import { useStaffClock, useStaffT } from "./StaffLanguage";
import { LanguageChoice } from "./LanguageChoice";
import { staffLocales } from "@/lib/staff-locales";

type Account = Admin & { manageable?: boolean };
interface Invitation {
  id: number;
  adminId: number | null;
  name: string;
  email: string;
  venueId: number | null;
  businessId: number | null;
  role: "manager" | "desk";
  invitedBy: string | null;
  sentAt: string;
  expired: boolean;
  manageable?: boolean;
}

/**
 * Staff accounts under *Venues & staff* (lib/staff-accounts.ts): who works
 * where, in what role, and the invitations not yet accepted. The platform
 * owner manages every account, a business manager their business's, and a
 * branch manager their own branch's front desk; the server says which rows
 * the signed-in account may change (`manageable`).
 *
 * New staff are invited by email to choose their own password; only where
 * the install cannot send email does the manager give one.
 */
export function StaffAccounts({ admin, venues, onError, onNotice }: { admin: Admin; venues: ManagedVenue[]; onError: (e: string | null) => void; onNotice: (n: string | null) => void }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const isOwner = admin.venueId === null && admin.businessId === null;
  const isManager = admin.businessId !== null;
  const branchManager = admin.venueId !== null && admin.role === "manager";
  // "" another platform owner, "business" a manager of the whole business, an id that branch.
  const staffDefault = branchManager ? String(admin.venueId) : isManager ? "business" : "";
  const blank = { name: "", email: "", password: "", venueId: staffDefault, role: "desk", locale: "" };
  const [newStaff, setNewStaff] = useState(blank);
  const [admins, setAdmins] = useState<Account[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [options, setOptions] = useState<{ invitations: boolean; typedPassword: boolean }>({ invitations: true, typedPassword: false });
  const [editing, setEditing] = useState<{ id: number; name: string; email: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/admins", { cache: "no-store" });
    if (!res.ok) return;
    const data = await readJson(res);
    setAdmins(data.admins);
    setInvitations(data.invitations ?? []);
    setOptions({ invitations: data.invitationsPossible !== false, typedPassword: !!data.typedPassword });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(url: string, method: string, body: unknown, okMessage: string | ((data: Record<string, unknown>) => string), after?: () => void) {
    onError(null);
    onNotice(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("vn.requestFailed")));
      onNotice(typeof okMessage === "string" ? okMessage : okMessage(data));
      after?.();
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : t("vn.requestFailed"));
    }
  }

  const inputClass = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const placeOf = (a: { venueId: number | null; businessId: number | null; businessName?: string | null }) =>
    a.businessId !== null ? (
      <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">{t("vn.managerOf", { business: a.businessName ?? admin.businessName ?? "" })}</span>
    ) : a.venueId === null ? (
      <span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-semibold text-violet-700">{t("vn.platformOwner")}</span>
    ) : (
      <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-semibold text-teal-700">
        {venues.find((v) => v.id === a.venueId)?.name ?? t("vn.venueN", { id: a.venueId })}
      </span>
    );
  // Typing a password is offered only where the install cannot email an invitation; blank then invites if it can.
  const typed = options.typedPassword;

  return (
    <section>
      <h2 className="text-lg font-bold">{t("vn.staffAccounts")}</h2>
      <p className="mt-1 text-sm text-slate-600">
        {isOwner ? t("vn.staffIntroOwner") : isManager ? t("vn.staffIntroManager") : t("r9a.staffIntroBranch")}
      </p>
      {admins && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                {[t("c.name"), t("c.email"), t("vn.scope"), ""].map((h, i) => (
                  <th key={i} className="px-3 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id} className="border-b border-slate-100 last:border-0">
                  {editing?.id === a.id ? (
                    <>
                      <td className="px-3 py-2">
                        <input aria-label={t("r9a.nameOf", { name: a.name })} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={`w-36 ${inputClass}`} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="email" aria-label={t("r9a.emailOf", { name: a.name })} value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} className={`w-52 ${inputClass}`} />
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2 font-medium">{a.name}</td>
                      <td className="px-3 py-2">{a.email}</td>
                    </>
                  )}
                  <td className="px-3 py-2">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {placeOf(a)}
                      {/* What they may do there: run the day, or set the venue up too. A branch manager changes no role. */}
                      {a.venueId !== null &&
                        (a.manageable && !branchManager ? (
                          <select
                            aria-label={t("vn.roleOf", { name: a.name })}
                            value={a.role}
                            onChange={(e) => void send(`/api/admin/admins/${a.id}`, "PATCH", { role: e.target.value }, t("vn.roleChanged"))}
                            className="rounded-md border border-slate-300 px-1.5 py-0.5 text-xs"
                          >
                            <option value="manager">{t("vn.manager")}</option>
                            <option value="desk">{t("vn.desk")}</option>
                          </select>
                        ) : (
                          <span className="text-xs text-slate-500">{a.role === "desk" ? t("vn.desk") : t("vn.manager")}</span>
                        ))}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {a.manageable &&
                      (editing?.id === a.id ? (
                        <>
                          <button
                            onClick={() =>
                              void send(
                                `/api/admin/admins/${a.id}`,
                                "PATCH",
                                { name: editing.name, email: editing.email },
                                (data) => (data.invited ? t("r9a.addressInvited", { email: editing.email }) : t("r9a.corrected")),
                                () => setEditing(null)
                              )
                            }
                            className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-700"
                          >
                            {t("c.save")}
                          </button>
                          <button onClick={() => setEditing(null)} className="ml-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600">
                            {t("c.cancel")}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => setEditing({ id: a.id, name: a.name, email: a.email })}
                            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                          >
                            {t("r9a.correct")}
                          </button>
                          <button
                            onClick={() => {
                              if (!window.confirm(t("vn.removeConfirm", { email: a.email }))) return;
                              void send(`/api/admin/admins/${a.id}`, "DELETE", undefined, (data) => {
                                // What happened to the API keys and webhook addresses around the account (ADR 0064).
                                const c = data.credentials as { stopped: number; review: { keys: number; webhooks: number } } | undefined;
                                const review = (c?.review.keys ?? 0) + (c?.review.webhooks ?? 0);
                                return c && c.stopped + review > 0 ? t("sec.removedNote", { stopped: c.stopped, review }) : t("vn.removed");
                              });
                            }}
                            className="ml-1.5 rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                          >
                            {t("c.remove")}
                          </button>
                          {/* Two-factor resets are the owner's and a business manager's (lib/two-factor-reset.ts). */}
                          {!branchManager && (
                            <button
                              onClick={() => {
                                // Only when they have lost both their authenticator and recovery codes (lib/two-factor-reset.ts).
                                const reason = window.prompt(t("vn.resetPrompt", { email: a.email }));
                                if (!reason) return;
                                const code = window.prompt(t("vn.ownCode"));
                                if (!code) return;
                                void send(`/api/admin/admins/${a.id}/two-factor-reset`, "POST", { reason, code }, t("vn.resetDone"));
                              }}
                              className="ml-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                            >
                              {t("vn.resetButton")}
                            </button>
                          )}
                        </>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {invitations.length > 0 && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">{t("r9a.invitations")}</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{i.name}</span>
                <span className="text-slate-600">{i.email}</span>
                {placeOf(i)}
                {i.venueId !== null && <span className="text-xs text-slate-500">{i.role === "desk" ? t("vn.desk") : t("vn.manager")}</span>}
                <span className="text-xs text-slate-500">
                  {i.adminId !== null ? t("r9a.newAddress") : t("r9a.pending")} · {t("r9a.sentAt", { when: clock.when(i.sentAt, i.venueId) })}
                  {i.invitedBy ? ` · ${t("r9a.invitedBy", { name: i.invitedBy })}` : ""}
                </span>
                {i.expired && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">{t("r9a.expired")}</span>}
                {i.manageable && (
                  <span className="ml-auto flex gap-1.5">
                    <button
                      onClick={() => void send(`/api/admin/admins/invitations/${i.id}`, "POST", {}, t("r9a.resent", { email: i.email }))}
                      className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      {t("r9a.resend")}
                    </button>
                    <button
                      onClick={() => {
                        if (!window.confirm(t("r9a.withdrawConfirm", { email: i.email }))) return;
                        void send(`/api/admin/admins/invitations/${i.id}`, "DELETE", undefined, t("r9a.withdrawn"));
                      }}
                      className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      {t("r9a.withdraw")}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const body =
            newStaff.venueId === "business"
              ? { ...newStaff, venueId: null, businessId: admin.businessId }
              : { ...newStaff, venueId: newStaff.venueId ? Number(newStaff.venueId) : null };
          // A branch manager adds front desk; nobody's password is sent when there is none to send.
          const { password, ...rest } = { ...body, role: branchManager ? "desk" : body.role };
          void send(
            "/api/admin/admins",
            "POST",
            typed && password !== "" ? { ...rest, password } : rest,
            (data) => (data.invitation ? t("r9a.invited", { email: newStaff.email }) : t("vn.added", { name: newStaff.email })),
            () => setNewStaff(blank)
          );
        }}
        className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4"
      >
        <p className="w-full text-xs text-slate-500">{typed ? (options.invitations ? t("r9a.typedOrInvite") : t("r9a.noEmail")) : t("r9a.inviteHelp")}</p>
        <input
          required minLength={2} placeholder={t("c.name")} aria-label={t("c.name")} value={newStaff.name}
          onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })}
          className={`w-40 ${inputClass}`}
        />
        <input
          required type="email" placeholder={t("c.email")} aria-label={t("c.email")} value={newStaff.email}
          onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })}
          className={`w-52 ${inputClass}`}
        />
        {typed && (
          <input
            required={!options.invitations} type="password" minLength={8}
            placeholder={t("vn.password")}
            aria-label={t("vn.password")}
            value={newStaff.password}
            onChange={(e) => setNewStaff({ ...newStaff, password: e.target.value })}
            className={`w-56 ${inputClass}`}
          />
        )}
        {!branchManager && (
          <select aria-label={t("q8b.l.venue")}
            value={newStaff.venueId}
            onChange={(e) => setNewStaff({ ...newStaff, venueId: e.target.value })}
            className={inputClass}
          >
            {isOwner ? <option value="">{t("vn.ownerAll")}</option> : <option value="business">{t("vn.managerAll")}</option>}
            {venues.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        )}
        {!branchManager && newStaff.venueId !== "" && newStaff.venueId !== "business" && (
          <select
            aria-label={t("vn.role")}
            value={newStaff.role}
            onChange={(e) => setNewStaff({ ...newStaff, role: e.target.value })}
            title={t("vn.roleHelp")}
            className={inputClass}
          >
            <option value="desk">{t("vn.desk")}</option>
            <option value="manager">{t("vn.manager")}</option>
          </select>
        )}
        {/* Their language, where known: the invitation, the dashboard and their emails are in it; they can change it. */}
        {staffLocales().length > 1 && (
          <LanguageChoice
            label={t("sl8.lang.staff")}
            value={newStaff.locale}
            onChange={(locale) => setNewStaff({ ...newStaff, locale })}
            locales={staffLocales()}
            className={inputClass}
          />
        )}
        <button type="submit" className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">
          {t("vn.addStaff")}
        </button>
      </form>
    </section>
  );
}
