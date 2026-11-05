"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import { formatMinute } from "@/lib/interval";
import type { WindowOverrideRow, WindowOverrideSettings } from "@/lib/window-overrides";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffMay } from "./StaffMay";
import { useStaffT } from "./StaffLanguage";

const input = "rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";

/**
 * A manager's overrides of advisory launch and tide windows (lib/window-overrides.ts; ADR 0046): the venue's settings for them (whether
 * its managers may, the shortest reason, the weekly alert) and the report of what was let through, with who, when, why and which window.
 * A manager's: front desk is shown nothing (the report is a manager's, `MANAGER_ONLY`). Shown under the venue's launch and tide
 * windows, and only where it has one.
 */
export function WindowOverridesPanel({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const may = useStaffMay()("windowOverrides");
  const [data, setData] = useState<{ settings: WindowOverrideSettings; overrides: WindowOverrideRow[]; days: number; alert: { count: number; limit: number } | null } | null>(null);
  const [form, setForm] = useState({ enabled: true, reasonMin: "", weeklyAlert: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/window-overrides?venueId=${venueId}`, { cache: "no-store" });
    if (!res.ok) return;
    const d = await readJson(res);
    setData(d);
    setForm({
      enabled: d.settings.enabled,
      reasonMin: d.settings.own.reasonMin ? String(d.settings.reasonMin) : "",
      weeklyAlert: d.settings.own.weeklyAlert ? String(d.settings.weeklyAlert) : "",
    });
  }, [venueId]);
  useEffect(() => {
    if (may) void load();
  }, [load, may]);

  if (!may || !data) return null;

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/window-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          enabled: form.enabled,
          reasonMin: form.reasonMin.trim() === "" ? null : Number(form.reasonMin),
          weeklyAlert: form.weeklyAlert.trim() === "" ? null : Number(form.weeklyAlert),
        }),
      });
      const out = await readJson(res);
      if (!res.ok) throw new Error(t.err(out, t("c.failed")));
      setNotice(t("safe1.ov.saved"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    } finally {
      setBusy(false);
    }
  }

  const { settings, overrides, alert } = data;
  return (
    <details className="mt-4 rounded-lg border border-slate-200 p-3 text-sm" data-testid="window-overrides">
      <summary className="cursor-pointer font-semibold">{t.plural("safe1.ov.title", overrides.length)}</summary>
      <p className="mt-2 text-xs text-slate-500">{t("safe1.ov.intro")}</p>
      {alert && <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">{t("safe1.ov.alert", { n: alert.count, limit: alert.limit })}</p>}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className="accent-teal-600" />
          {t("safe1.ov.enabled")}
        </label>
        <label className="text-xs text-slate-500">
          {t("safe1.ov.reasonMin")}
          <input
            type="number"
            min={3}
            max={300}
            value={form.reasonMin}
            placeholder={String(settings.own.reasonMin ? "" : settings.reasonMin)}
            onChange={(e) => setForm({ ...form, reasonMin: e.target.value })}
            className={`block w-24 ${input}`}
          />
        </label>
        <label className="text-xs text-slate-500">
          {t("safe1.ov.weeklyAlert")}
          <input
            type="number"
            min={0}
            max={1000}
            value={form.weeklyAlert}
            placeholder={String(settings.own.weeklyAlert ? "" : settings.weeklyAlert)}
            onChange={(e) => setForm({ ...form, weeklyAlert: e.target.value })}
            className={`block w-24 ${input}`}
          />
        </label>
        <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
          {busy ? t("c.saving") : t("c.save")}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">{t("safe1.ov.settingsHint")}</p>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-sm font-medium text-emerald-700">{notice}</p>}

      {overrides.length === 0 ? (
        <p className="mt-3 text-xs text-slate-600">{t("safe1.ov.none", { days: data.days })}</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {overrides.map((o) => (
            <li key={o.id} className="rounded-md bg-slate-50 px-2 py-1.5">
              <span className="font-medium">
                {o.date} {formatMinute(o.startMin, t.locale)}–{formatMinute(o.endMin, t.locale)}
              </span>{" "}
              · {o.courtName} · {o.bookingCode ? t("safe1.ov.booking", { code: o.bookingCode, name: o.who }) : t("safe1.ov.class", { name: o.who })}
              <span className="block text-xs text-slate-600">
                {t(`safe1.ov.action.${o.action}` as StaffPhrase)} · {t("safe1.ov.by", { name: o.adminName, when: o.createdAt.slice(0, 16).replace("T", " ") })}
              </span>
              <span className="block text-xs text-slate-600">{t("safe1.ov.window", { window: o.window })}</span>
              <span className="block text-xs">{t("safe1.ov.why", { reason: o.reason })}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
