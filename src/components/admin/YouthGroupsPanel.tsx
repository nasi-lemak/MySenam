"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { SeatLabel } from "@/lib/message-contexts";
import type { StaffYouthMessage, YouthGroupForStaff } from "@/lib/youth-safeguarding";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/**
 * Supervised youth groups that are this staff member's to look after (`/api/admin/youth-groups`; docs/features/player-messages.md
 * #supervised-youth-groups): a venue's manager sees the groups that asked their venue (to accept or decline, and then to read), the platform
 * owner those with no venue. Reading a group's conversation is a deliberate exception to "nobody on staff reads an ordinary message", for
 * supervised youth groups only: managers only, and each reading is recorded in the activity log. The panel is not shown at all where there is no
 * such group, so a venue that has not opened this sees nothing of it.
 */
export function YouthGroupsPanel() {
  const t = useStaffT();
  const clock = useStaffClock();
  const [groups, setGroups] = useState<YouthGroupForStaff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<{ groupId: number; messages: StaffYouthMessage[] } | null>(null);
  const [reasons, setReasons] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/youth-groups", { cache: "no-store" });
      const data = await readJson(res).catch(() => null);
      if (!res.ok) throw new Error(t.err(data, t("ysg.loadFailed")));
      setGroups(data.groups as YouthGroupForStaff[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ysg.loadFailed"));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch("/api/admin/youth-groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) return setError(t.err(data, t("ysg.actionFailed")));
    setReading(null);
    await load();
  }

  async function read(groupId: number) {
    setError(null);
    const res = await fetch(`/api/admin/youth-groups?group=${groupId}`, { cache: "no-store" });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) return setError(t.err(data, t("ysg.actionFailed")));
    setReading({ groupId, messages: data.messages as StaffYouthMessage[] });
  }

  if (!groups || groups.length === 0) return null;
  const label = (from: SeatLabel | null) => (from ? (from.n ?? from.c ?? "") : t("pmg.former"));
  const who = (list: { name: string; declaredRole: string }[]) =>
    list.length ? list.map((a) => `${a.name} (${t(`ysg.declared.${a.declaredRole}` as "ysg.declared.other")})`).join(", ") : t("ysg.none.list");
  const small = "min-h-9 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-teal-500";

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm" data-testid="youth-groups-panel">
      <summary className="cursor-pointer font-semibold text-slate-800">{t("ysg.title")}</summary>
      <p className="mt-2 text-slate-600">{t("ysg.intro")}</p>
      {error && (
        <p role="alert" className="mt-2 text-red-600">
          {error}
        </p>
      )}
      <ul className="mt-3 space-y-3">
        {groups.map((g) => (
          <li key={g.groupId} className="rounded-lg border border-slate-200 px-3 py-2">
            <p className="font-semibold">
              {g.name}
              {g.pending && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">{t("ysg.pending")}</span>}
              {g.ended && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{t("ysg.ended")}</span>}
            </p>
            <p className="text-slate-600">{t("ysg.organiser", { name: g.organiser })}</p>
            <p className="text-slate-600">{t("ysg.supervisors", { list: who(g.supervisors) })}</p>
            <p className="text-slate-600">{t("ysg.adults", { list: who(g.adults) })}</p>
            <p className="text-slate-600">{t("ysg.minors", { n: g.minors })}</p>
            <p className="text-slate-600">
              {g.threadState ? t("ysg.thread", { state: t(`pmg.thread.${g.threadState}`), n: g.messages }) : t("ysg.thread.none")}
              {g.openReports > 0 && <strong className="ml-2 text-red-700">{t("ysg.reportsOpen", { n: g.openReports })}</strong>}
            </p>
            <div className="mt-2 space-y-2">
              {g.pending ? (
                <div className="flex flex-wrap gap-2">
                  <button className={small} onClick={() => void act({ action: "answer", groupId: g.groupId, accept: true })}>
                    {t("ysg.accept")}
                  </button>
                  <button className={small} onClick={() => void act({ action: "answer", groupId: g.groupId, accept: false })}>
                    {t("ysg.decline")}
                  </button>
                </div>
              ) : (
                !g.ended && (
                  <>
                    <div className="flex flex-wrap gap-2">
                      <button className={small} onClick={() => (reading?.groupId === g.groupId ? setReading(null) : void read(g.groupId))}>
                        {reading?.groupId === g.groupId ? t("ysg.hide") : t("ysg.read")}
                      </button>
                    </div>
                    {reading?.groupId === g.groupId && (
                      <div className="space-y-1 rounded-md bg-slate-50 p-2">
                        <p className="text-xs text-slate-500">{t("ysg.readNote")}</p>
                        {reading.messages.length === 0 && <p className="text-slate-500">{t("ysg.empty")}</p>}
                        <ol className="space-y-1">
                          {reading.messages.map((m) => (
                            <li key={m.id} className={`rounded px-2 py-1 ${m.removed ? "bg-amber-50" : "bg-white"}`}>
                              <span className="text-xs font-semibold text-slate-600">
                                {label(m.from)} · {clock.when(m.at)}
                                {m.removed && <> · {t("ysg.removedMsg")}</>}
                              </span>
                              {/* Plain text: nothing in a message is interpreted or opened. */}
                              <p className="whitespace-pre-wrap break-words text-slate-800">{m.body ?? t("pmg.removed")}</p>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                    <label className="block text-xs font-medium text-slate-600">
                      {t("ysg.reasonLabel")}
                      <input
                        value={reasons[g.groupId] ?? ""}
                        onChange={(e) => setReasons((had) => ({ ...had, [g.groupId]: e.target.value }))}
                        maxLength={300}
                        className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      />
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <button className={`${small} text-red-700`} onClick={() => void act({ action: "end", groupId: g.groupId, reason: reasons[g.groupId] ?? "" })}>
                        {t("ysg.end")}
                      </button>
                      <span className="text-xs text-slate-500">{t("ysg.endNote")}</span>
                    </div>
                  </>
                )
              )}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
