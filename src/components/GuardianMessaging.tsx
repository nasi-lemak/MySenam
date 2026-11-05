"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { senderText } from "@/lib/message-titles";
import type { GuardianChildView } from "@/lib/youth-messages";
import type { ReadOnlyMessage } from "@/lib/youth-safeguarding";

type Reading = { participantId: number; groupId: number; group: string; child: string; messages: ReadOnlyMessage[] };

/**
 * A guardian's controls over group messaging for the children they act for, on the "people I act for" page (docs/features/player-messages.md
 * #supervised-youth-groups; ADR 0044). Nothing here is part of anybody's setup: it appears only for a guardian of a child whose own login is
 * linked and who is in a supervised youth group. Messaging is off until a guardian switches it on for that child and that group; it can be
 * switched off at once, per group or everywhere; the guardian can read the group's conversation (read-only, each read recorded), block
 * somebody for the child (never a supervisor) and choose how often notices about the child's messages come.
 */
export default function GuardianMessaging() {
  const t = useT();
  const [children, setChildren] = useState<GuardianChildView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [hours, setHours] = useState(6);

  const load = useCallback(async () => {
    const res = await fetch("/api/my/people/messaging", { cache: "no-store" });
    if (res.ok) {
      const data = await readJson(res);
      setChildren(data.children);
      if (typeof data.digestHours === "number") setHours(data.digestHours);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setError(null);
    setNotice(null);
    const res = await fetch("/api/my/people/messaging", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) return setError(translateError(t, data));
    setChildren(data.children);
    setNotice(t("pmy.guardian.done"));
  }

  async function read(participantId: number, groupId: number) {
    setError(null);
    const res = await fetch(`/api/my/people/messaging?participantId=${participantId}&groupId=${groupId}`, { cache: "no-store" });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) return setError(translateError(t, data));
    setReading({ participantId, groupId, group: data.group, child: data.child, messages: data.messages });
  }

  // Nothing at all for a guardian none of whose children is in a youth group.
  if (!children || children.every((c) => c.groups.length === 0)) return null;
  const when = (at: string) => new Intl.DateTimeFormat(t.locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(`${at.replace(" ", "T")}Z`));
  const names = (list: { name: string; declaredRole: string }[]) => list.map((a) => `${a.name} (${t(`pmy.group.declared.${a.declaredRole}` as "pmy.group.declared.other")})`).join(", ");
  const small = "min-h-9 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:border-teal-500";

  return (
    <section aria-labelledby="pmy-guardian" className="mt-8 space-y-4" data-testid="guardian-messaging">
      <div>
        <h2 id="pmy-guardian" className="text-lg font-semibold">
          {t("pmy.guardian.title")}
        </h2>
        <p className="text-sm text-slate-600">{t("pmy.guardian.intro")}</p>
        <p className="text-sm text-slate-600">{t("pmy.guardian.disagree")}</p>
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-900">
          {notice}
        </p>
      )}
      {children
        .filter((c) => c.groups.length > 0)
        .map((c) => (
          <div key={c.participantId} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm">
            <h3 className="font-semibold text-slate-900">{c.displayName}</h3>
            <label className="block font-medium">
              {t("pmy.guardian.notices", { child: c.displayName })}
              <select
                value={c.noticeMode}
                onChange={(e) => void act({ action: "notices", participantId: c.participantId, mode: e.target.value })}
                className="mt-1 block w-full max-w-sm rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
              >
                <option value="immediate">{t("pmy.notice.immediate")}</option>
                <option value="digest">{t("pmy.notice.digest", { n: hours })}</option>
                <option value="daily">{t("pmy.notice.daily")}</option>
                <option value="off">{t("pmy.notice.off")}</option>
              </select>
            </label>
            <p className="text-xs text-slate-500">{t("pmy.guardian.noticeHelp")}</p>
            <ul className="space-y-3">
              {c.groups.map((g) => (
                <li key={g.groupId} className="space-y-2 rounded-lg border border-slate-200 p-3">
                  <p className="font-medium text-slate-900">{g.name}</p>
                  <p className="text-slate-600">{t("pmy.guardian.supervisors", { list: g.supervisors.length ? names(g.supervisors) : "-" })}</p>
                  {g.adults.length > 0 && <p className="text-slate-600">{t("pmy.guardian.adults", { list: names(g.adults) })}</p>}
                  <p className={g.consentOn ? "text-emerald-700" : "text-slate-600"}>{g.consentOn ? t("pmy.guardian.on", { child: c.displayName }) : t("pmy.guardian.off", { child: c.displayName })}</p>
                  {/* All anybody is told of an objection: never who, never why (ADR 0049). */}
                  {g.needsAgreement && <p className="text-amber-800">{t("pmy.guardian.needsAgreement", { child: c.displayName })}</p>}
                  {g.needsAgreement && g.myConsent && <p className="text-slate-600">{t("pmy.guardian.agreedWaiting")}</p>}
                  {c.authority === "objects_only" && <p className="text-slate-600">{t("pmy.guardian.objectsOnly", { child: c.displayName })}</p>}
                  <p className="text-slate-600">{g.childOptedIn ? t("pmy.guardian.childOn", { child: c.displayName }) : t("pmy.guardian.childOff", { child: c.displayName })}</p>
                  <div className="flex flex-wrap gap-2">
                    {(g.consentOn || g.myConsent || c.authority !== "objects_only") && (
                      <button onClick={() => void act({ action: "consent", participantId: c.participantId, groupId: g.groupId, on: !(g.consentOn || g.myConsent) })} className={small} aria-pressed={g.consentOn || g.myConsent}>
                        {g.consentOn || g.myConsent ? t("pmy.guardian.switchOff", { child: c.displayName }) : t("pmy.guardian.switchOn", { child: c.displayName })}
                      </button>
                    )}
                    {c.authority === "objects_only" && !g.consentOn && !g.myConsent && (
                      <button onClick={() => void act({ action: "consent", participantId: c.participantId, groupId: g.groupId, on: false })} className={small}>
                        {t("pmy.guardian.switchOff", { child: c.displayName })}
                      </button>
                    )}
                    <button onClick={() => (reading?.groupId === g.groupId && reading.participantId === c.participantId ? setReading(null) : void read(c.participantId, g.groupId))} className={small}>
                      {reading?.groupId === g.groupId && reading.participantId === c.participantId ? t("pmy.guardian.hide") : t("pmy.guardian.read")}
                    </button>
                  </div>
                  {g.blocked.length > 0 && <p className="text-xs text-slate-500">{t("pmy.guardian.blocked", { child: c.displayName, names: g.blocked.map((b) => senderText(t, b.label)).join(", ") })}</p>}
                  {g.others.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {g.others.map((o) => (
                        <button key={o.userId} onClick={() => void act({ action: "block", participantId: c.participantId, groupId: g.groupId, userId: o.userId })} className="min-h-8 rounded border border-slate-200 px-2 text-xs hover:border-red-400">
                          {t("pmy.guardian.block", { name: senderText(t, o.label), child: c.displayName })}
                        </button>
                      ))}
                    </div>
                  )}
                  {reading?.groupId === g.groupId && reading.participantId === c.participantId && (
                    <div className="space-y-2 rounded-md bg-slate-50 p-3" aria-live="polite" data-testid="guardian-reading">
                      <p className="font-semibold">{t("pmy.guardian.reading", { child: reading.child })}</p>
                      <p className="text-xs text-slate-500">{t("pmy.guardian.readOnly")}</p>
                      {reading.messages.length === 0 && <p className="text-slate-500">{t("pmy.guardian.empty")}</p>}
                      <ol className="space-y-1">
                        {reading.messages.map((m) => (
                          <li key={m.id}>
                            <span className="text-xs font-semibold text-slate-600">{m.child ? reading.child : senderText(t, m.from)}</span>{" "}
                            <time className="text-xs text-slate-500" dateTime={`${m.at.replace(" ", "T")}Z`}>
                              {when(m.at)}
                            </time>
                            {/* Plain text, never a link. */}
                            <p className={`whitespace-pre-wrap break-words ${m.body === null ? "italic text-slate-500" : ""}`}>{m.body ?? (m.removed ? t("pmy.thread.removed") : t("pmsg.removed"))}</p>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <button onClick={() => window.confirm(t("pmy.guardian.allOff", { child: c.displayName })) && void act({ action: "allOff", participantId: c.participantId })} className={`${small} text-red-700`}>
              {t("pmy.guardian.allOff", { child: c.displayName })}
            </button>
          </div>
        ))}
      <p className="text-xs text-slate-500">{t("pmy.guardian.export")}</p>
    </section>
  );
}
