"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { YouthGroupState } from "@/lib/youth-messages";

const DECLARED = ["coach", "venue_staff", "volunteer", "parent", "other"] as const;

/**
 * A group's supervised-youth settings, for its organiser (docs/features/player-messages.md#supervised-youth-groups; ADR 0044). An advanced
 * setting, closed until opened, and never part of anybody's setup. Marking a group lets members who have not said they are 18 or over take
 * part in its conversation, each only with a guardian's consent and their own; it never lets any of them message anyone privately. The
 * organiser is the first supervisor; adults are in the conversation only if let in here, each with what they say they are.
 */
export function YouthGroupPanel({ groupId }: { groupId: number }) {
  const t = useT();
  const [state, setState] = useState<YouthGroupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [member, setMember] = useState("");
  const [role, setRole] = useState<"supervisor" | "adult">("adult");
  const [declared, setDeclared] = useState<string>("volunteer");
  const [venue, setVenue] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/groups/${groupId}/youth`, { cache: "no-store" });
    if (res.ok) setState((await readJson(res)).state);
  }, [groupId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/groups/${groupId}/youth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) return setError(translateError(t, data) || t("pmy.group.failed"));
    setNotice(t("pmy.group.saved"));
    await load();
  }

  if (!state?.organiser) return null;
  const small = "min-h-9 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:border-teal-500";
  const input = "mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const roleName = (r: string) => t(`pmy.group.declared.${r}` as "pmy.group.declared.other");

  return (
    <details className="rounded-xl border border-slate-200 bg-white p-3 text-sm" data-testid="youth-group-panel">
      <summary className="min-h-8 cursor-pointer font-semibold">{t("pmy.group.summary")}</summary>
      <div className="mt-3 space-y-4">
        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-700">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-md bg-teal-50 px-3 py-2 text-teal-900">
            {notice}
          </p>
        )}
        {!state.marked && (
          <>
            <p className="text-slate-700">{t("pmy.group.intro")}</p>
            <button onClick={() => void act({ action: "mark" })} className={small}>
              {t("pmy.group.mark")}
            </button>
          </>
        )}
        {state.ended && <p className="text-slate-700">{t("pmy.group.ended")}</p>}
        {state.marked && !state.ended && (
          <>
            <p className="font-medium text-slate-900">{t("pmy.group.marked")}</p>
            <p className="text-slate-600">{t("pmy.group.opensWith")}</p>
            <p className="text-slate-600">{t.plural("pmy.group.minors", state.minors)}</p>

            <section aria-labelledby="pmy-adults" className="space-y-2">
              <h3 id="pmy-adults" className="font-semibold">
                {t("pmy.group.adults")}
              </h3>
              <p className="text-xs text-slate-500">{t("pmy.group.adultsHelp")}</p>
              <ul className="space-y-1">
                {state.adults.map((a) => (
                  <li key={a.userId} className="flex flex-wrap items-center gap-2">
                    <span>
                      {a.name} · {t(`pmy.group.role.${a.role}` as "pmy.group.role.adult")} · {roleName(a.declaredRole)}
                    </span>
                    {a.declaredRole !== "organiser" && (
                      <button onClick={() => void act({ action: "removeAdult", memberUserId: a.userId })} className="min-h-8 rounded border border-slate-200 px-2 text-xs hover:border-red-400">
                        {t("pmy.group.remove")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {state.candidates.length === 0 ? (
                <p className="text-xs text-slate-500">{t("pmy.group.noAdults")}</p>
              ) : (
                <form
                  className="grid gap-2 sm:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act({ action: "adult", memberUserId: Number(member), role, declaredRole: declared });
                  }}
                >
                  <label className="block font-medium">
                    {t("pmy.group.member")}
                    <select value={member} onChange={(e) => setMember(e.target.value)} required className={input}>
                      <option value="" disabled />
                      {state.candidates.map((c) => (
                        <option key={c.userId} value={c.userId}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block font-medium">
                    {t("pmy.group.asRole")}
                    <select value={role} onChange={(e) => setRole(e.target.value as "supervisor" | "adult")} className={input}>
                      <option value="adult">{t("pmy.group.role.adult")}</option>
                      <option value="supervisor">{t("pmy.group.role.supervisor")}</option>
                    </select>
                  </label>
                  <label className="block font-medium">
                    {t("pmy.group.iAm")}
                    <select value={declared} onChange={(e) => setDeclared(e.target.value)} className={input}>
                      {DECLARED.map((d) => (
                        <option key={d} value={d}>
                          {roleName(d)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex items-end">
                    <button type="submit" className={small}>
                      {t("pmy.group.addAdult")}
                    </button>
                  </div>
                </form>
              )}
            </section>

            <section aria-labelledby="pmy-venue" className="space-y-2">
              <h3 id="pmy-venue" className="font-semibold">
                {t("pmy.group.venue")}
              </h3>
              <p className="text-xs text-slate-500">{t("pmy.group.venueHelp")}</p>
              {state.venue && <p>{t("pmy.group.venueAccepted", { name: state.venue.name })}</p>}
              {state.venueRequested && (
                <p className="flex flex-wrap items-center gap-2">
                  {t("pmy.group.venueRequested", { name: state.venueRequested.name })}
                  <button onClick={() => void act({ action: "venue", venueId: null })} className="min-h-8 rounded border border-slate-200 px-2 text-xs hover:border-teal-500">
                    {t("pmy.group.venueWithdraw")}
                  </button>
                </p>
              )}
              {!state.venue && !state.venueRequested && (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act({ action: "venue", venueId: Number(venue) });
                  }}
                >
                  <label className="block font-medium">
                    {t("pmy.group.venueId")}
                    <input value={venue} onChange={(e) => setVenue(e.target.value)} inputMode="numeric" pattern="[0-9]+" required className={input} />
                  </label>
                  <button type="submit" className={small}>
                    {t("pmy.group.venueAsk")}
                  </button>
                </form>
              )}
            </section>

            <section aria-labelledby="pmy-quiet" className="space-y-2">
              <h3 id="pmy-quiet" className="font-semibold">
                {t("pmy.group.quiet", "off" in state.quiet ? { from: "--:--", to: "--:--" } : { from: state.quiet.installFrom, to: state.quiet.installTo })}
              </h3>
              {"off" in state.quiet && <p className="text-xs text-slate-500">{t("pmy.group.quietOff")}</p>}
              {state.groupQuiet && <p>{t("pmy.group.quietOwn", state.groupQuiet)}</p>}
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act({ action: "quiet", from, to });
                }}
              >
                <label className="block font-medium">
                  {t("pmy.group.quietFrom")}
                  <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="21:30" pattern="[0-9]{1,2}:[0-9]{2}" required className={input} />
                </label>
                <label className="block font-medium">
                  {t("pmy.group.quietTo")}
                  <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="07:30" pattern="[0-9]{1,2}:[0-9]{2}" required className={input} />
                </label>
                <button type="submit" className={small}>
                  {t("pmy.group.quietSave")}
                </button>
                {state.groupQuiet && (
                  <button type="button" onClick={() => void act({ action: "quiet", from: null, to: null })} className={small}>
                    {t("pmy.group.quietClear")}
                  </button>
                )}
              </form>
            </section>

            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (window.confirm(t("pmy.group.end"))) void act({ action: "end", reason });
              }}
            >
              <label className="block font-medium">
                {t("pmy.group.reason")}
                <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={300} className={input} name="endReason" />
              </label>
              <button type="submit" className={`${small} text-red-700`}>
                {t("pmy.group.end")}
              </button>
            </form>
          </>
        )}
      </div>
    </details>
  );
}
