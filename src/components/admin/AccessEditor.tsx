"use client";

import { useCallback, useEffect, useState } from "react";
import type { AccessEntry, AccessKind, AccessSettings, VenueAccess } from "@/lib/access";
import { money, region } from "@/lib/region";
import type { StaffT } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";
import { PhoneCheckAdvice } from "./PhoneCheckAdvice";

const modes = (t: StaffT): { value: VenueAccess; label: string; note: string }[] => [
  { value: "public", label: t("acs.public"), note: t("acs.publicNote") },
  { value: "members", label: t("acs.members"), note: t("acs.membersNote") },
  { value: "private", label: t("acs.private"), note: t("acs.privateNote") },
];

const kindLabels = (t: StaffT): Record<AccessKind, string> => ({ resident: t("acs.resident"), member: t("acs.member"), guest: t("acs.guest") });

interface State {
  settings: AccessSettings;
  list: AccessEntry[];
  phoneChecks: boolean;
  guests?: { perResident: number; days: number };
}

/**
 * Who one venue is for — public, members only or private — and the list of
 * people it lets in, by phone number: one at a time, or pasted from the
 * management office's spreadsheet.
 */
export function AccessEditor({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const MODES = modes(t);
  const KIND_LABELS = kindLabels(t);
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<State | null>(null);
  const [mode, setMode] = useState<VenueAccess>("public");
  const [listed, setListed] = useState(true);
  const [note, setNote] = useState("");
  const [person, setPerson] = useState({ phone: "", name: "", label: "", kind: "resident" as AccessKind, expiresOn: "", account: "" });
  const [paste, setPaste] = useState("");
  const [guests, setGuests] = useState({ perResident: "0", days: "3" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const take = (data: State) => {
    setS((old) => ({ ...data, phoneChecks: data.phoneChecks ?? old?.phoneChecks ?? false }));
    if (data.guests) setGuests({ perResident: String(data.guests.perResident), days: String(data.guests.days) });
    setMode(data.settings.access);
    setListed(data.settings.access !== "members" || data.settings.listed);
    setNote(data.settings.note ?? "");
  };

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/venue-access?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) take(await res.json());
  }, [venueId]);

  useEffect(() => {
    if (open && s === null) void load();
  }, [open, s, load]);

  async function post(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/venue-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("vn.couldNotSave")));
      take(data);
      setNotice(typeof data.added === "number" ? t("acs.imported", { added: data.added, updated: data.updated }) : ok);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vn.couldNotSave"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  const current = s?.settings.access ?? "public";
  return (
    <div className="mt-3">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
        {open ? t("acs.hide") : s ? t("acs.showCurrent", { mode: MODES.find((m) => m.value === current)?.label ?? "" }) : t("acs.show")}
      </button>
      {open && s && (
        <div className="mt-2 space-y-4 rounded-xl border border-slate-200 bg-white p-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">{t("acs.legend")}</legend>
            {MODES.map((m) => (
              <label key={m.value} className="flex gap-2 text-sm">
                <input type="radio" name={`access-${venueId}`} checked={mode === m.value} onChange={() => setMode(m.value)} className="mt-1" />
                <span>
                  <span className="font-medium">{m.label}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{m.note}</span>
                </span>
              </label>
            ))}
            {mode === "members" && (
              <label className="ml-6 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} />
                {t("acs.listed")}
              </label>
            )}
            {/* Members only or private: what phone checks would give, and what happens without them. */}
            {mode !== "public" && <PhoneCheckAdvice on={s.phoneChecks} where="access" />}
            {mode !== "public" && (
              <label className="block text-sm">
                {t("acs.noteLabel")}
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  maxLength={500}
                  placeholder={mode === "members" ? t("acs.membersExample", { amount: money(150), phone: region().phone.example }) : t("acs.privateExample")}
                  className={`mt-1 w-full ${input}`}
                />
              </label>
            )}
            <button
              disabled={busy}
              onClick={() => post({ action: "settings", access: mode, listed, note }, t("c.saved"))}
              className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {t("c.save")}
            </button>
          </fieldset>

          {current !== "public" && (
            <fieldset className="space-y-2 border-t border-slate-100 pt-3">
              <legend className="text-sm font-semibold">{t("acs.guestsTitle")}</legend>
              <p className="text-xs text-slate-500">{t("acs.guestsIntro")}</p>
              <div className="flex flex-wrap items-end gap-2 text-sm">
                <label className="text-xs text-slate-600">
                  {t("acs.guestsEach")}
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={guests.perResident}
                    onChange={(e) => setGuests({ ...guests, perResident: e.target.value })}
                    className={`mt-0.5 block w-20 ${input}`}
                  />
                </label>
                <label className="text-xs text-slate-600">
                  {t("acs.guestsDays")}
                  <input
                    type="number"
                    min={1}
                    max={14}
                    value={guests.days}
                    onChange={(e) => setGuests({ ...guests, days: e.target.value })}
                    className={`mt-0.5 block w-20 ${input}`}
                  />
                </label>
                <button
                  disabled={busy}
                  onClick={() =>
                    post({ action: "guests", perResident: Number(guests.perResident), days: Number(guests.days) }, t("c.saved"))
                  }
                  className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {t("c.save")}
                </button>
              </div>
            </fieldset>
          )}

          {(current !== "public" || s.list.length > 0) && (
            <div className="space-y-3 border-t border-slate-100 pt-3">
              <p className="text-sm font-semibold">
                {t("acs.listCount", { n: s.list.length })}{" "}
                {current === "members" && <span className="font-normal text-slate-500">{t("acs.plusMembers")}</span>}
              </p>
              <p className="text-xs text-slate-500">
                {s.phoneChecks ? t("acc5.ruleChecks") : t("acc5.ruleNoChecks")} {t("acs.guestsDrop")}
              </p>
              {s.list.some((e) => !e.account && !e.proved) && (
                <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  {t("acc5.unlinkedCount", { n: s.list.filter((e) => !e.account && !e.proved).length })}
                </p>
              )}
              {s.list.length > 0 && (
                <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-slate-50 uppercase text-slate-500">
                      <tr>
                        <th className="px-2 py-1">{t("c.phone")}</th>
                        <th className="px-2 py-1">{t("c.name")}</th>
                        <th className="px-2 py-1">{t("acs.unit")}</th>
                        <th className="px-2 py-1">{t("acs.as")}</th>
                        <th className="px-2 py-1">{t("c.until")}</th>
                        <th className="px-2 py-1">{t("acs.account")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {s.list.map((e) => (
                        <tr key={e.id}>
                          <td className="px-2 py-1 font-mono">{e.phone}</td>
                          <td className="px-2 py-1">{e.name ?? ""}</td>
                          <td className="px-2 py-1">{e.label ?? ""}</td>
                          <td className="px-2 py-1">
                            {KIND_LABELS[e.kind]}
                            {e.invitedBy && <span className="block text-xs text-slate-500">{t("acs.invitedBy", { name: e.invitedBy })}</span>}
                            {e.invitation && (
                              <span className="block text-xs text-slate-500" data-testid="guest-invitation">
                                {e.invitation === "pending" ? t("rv7.pending") : t("rv7.withdrawn")}
                              </span>
                            )}
                            {e.invitation === "pending" && (
                              <button
                                disabled={busy}
                                onClick={() => {
                                  // Asking why is the confirm step: cancelled or left empty, nothing is sent.
                                  const reason = window.prompt(t("rv7.reasonPrompt", { name: e.name ?? e.phone }));
                                  if (reason && reason.trim() !== "") void post({ action: "withdrawInvitation", id: e.id, reason }, t("rv7.withdrawnOk"));
                                }}
                                className="text-teal-700 hover:underline"
                              >
                                {t("rv7.withdraw")}
                              </button>
                            )}
                          </td>
                          <td className="px-2 py-1">{e.expiresOn ?? "—"}</td>
                          <td className="px-2 py-1">
                            {e.account ? (
                              <>
                                <span className="block">{e.account.name}</span>
                                <span className="block text-slate-500">{e.account.email}</span>
                                <button
                                  disabled={busy}
                                  onClick={() => window.confirm(t("acc5.unlinkConfirm", { name: e.name ?? e.phone })) && post({ action: "unlink", id: e.id }, t("acc5.unlinkedOk"))}
                                  className="text-teal-700 hover:underline"
                                >
                                  {t("acc5.unlink")}
                                </button>
                              </>
                            ) : (
                              <>
                                <span className={`block ${e.proved ? "text-emerald-700" : "text-amber-700"}`}>
                                  {e.proved ? t("acc5.proved") : e.hasAccount ? t("acc5.unlinkedHasAccount") : t("acc5.unlinked")}
                                </span>
                                <button
                                  disabled={busy}
                                  onClick={() => {
                                    const account = window.prompt(t("acc5.linkPrompt", { name: e.name ?? e.phone }));
                                    if (account && account.trim() !== "") void post({ action: "link", id: e.id, account }, t("acc5.linkedOk"));
                                  }}
                                  className="text-teal-700 hover:underline"
                                >
                                  {t("acc5.link")}
                                </button>
                              </>
                            )}
                          </td>
                          <td className="px-2 py-1 text-right">
                            <button
                              disabled={busy}
                              onClick={() => window.confirm(t("acs.removeConfirm", { name: e.name ?? e.phone })) && post({ action: "remove", id: e.id }, t("acs.removed"))}
                              className="text-red-600 hover:underline"
                            >
                              {t("c.remove")}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <input aria-label={t("c.phone")} placeholder={t("c.phone")} value={person.phone} onChange={(e) => setPerson({ ...person, phone: e.target.value })} className={`${input} w-36`} />
                <input aria-label={t("c.name")} placeholder={t("c.name")} value={person.name} onChange={(e) => setPerson({ ...person, name: e.target.value })} className={`${input} w-36`} />
                <input aria-label={t("acs.unitLabel")} placeholder={t("acs.unit")} value={person.label} onChange={(e) => setPerson({ ...person, label: e.target.value })} className={`${input} w-24`} />
                <input aria-label={t("acc5.accountField")} placeholder={t("acc5.accountField")} value={person.account} onChange={(e) => setPerson({ ...person, account: e.target.value })} className={`${input} w-56`} />
                <select aria-label={t("acs.as")} value={person.kind} onChange={(e) => setPerson({ ...person, kind: e.target.value as AccessKind })} className={input}>
                  {(Object.keys(KIND_LABELS) as AccessKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
                {person.kind === "guest" && (
                  <label className="text-xs text-slate-600">
                    {t("acs.until")}{" "}
                    <input type="date" value={person.expiresOn} onChange={(e) => setPerson({ ...person, expiresOn: e.target.value })} className={input} />
                  </label>
                )}
                <button
                  disabled={busy || person.phone.trim() === ""}
                  onClick={async () => {
                    if (await post({ action: "add", ...person }, t("acs.added"))) setPerson({ phone: "", name: "", label: "", kind: person.kind, expiresOn: "", account: "" });
                  }}
                  className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {t("c.add")}
                </button>
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-xs font-medium text-teal-700">{t("acs.paste")}</summary>
                <p className="mt-1 text-xs text-slate-500">
                  {t("acs.pasteLine")} <span className="font-mono">{t("acs.pasteFormat")}</span> {t("acs.pasteRest")}
                </p>
                {/* staff-i18n-ignore: sample rows in the import format (a number, a name, a unit), the same in every language */}
                <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} placeholder={`${region().phone.example}, Aisyah Rahman, A-12-3\n${region().phone.example}, Lee Wei, B-05-1`} className={`mt-1 w-full font-mono ${input}`} />
                <button
                  disabled={busy || paste.trim() === ""}
                  onClick={async () => {
                    if (await post({ action: "import", text: paste, kind: person.kind === "guest" ? "resident" : person.kind }, t("acs.importedOk"))) setPaste("");
                  }}
                  className="mt-1 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {person.kind === "member" ? t("acs.addMembers") : t("acs.addResidents")}
                </button>
              </details>
            </div>
          )}
          {error && <p className="text-sm font-medium text-red-700">{error}</p>}
          {notice && <p className="text-sm font-medium text-emerald-700">{notice}</p>}
        </div>
      )}
    </div>
  );
}
