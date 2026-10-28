"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import { ClockField } from "@/components/ClockField";
import { useT } from "@/components/Language";
import { isLocale, LOCALE_NAMES, offeredLocales, type Locale } from "@/lib/i18n";
import { formatMinute } from "@/lib/interval";
import type { WaitlistEntry } from "@/lib/types";
import { ParticipantPicker, type PickedParticipant } from "./ParticipantPicker";
import { useStaffT } from "./StaffLanguage";

const input = "rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";

/**
 * The language the offer goes in, to start with: the customer language this
 * member of staff reads the site in (the language switch), where the install
 * offers it, else English (else the install's first).
 */
export function startingLanguage(site: Locale, offered: Locale[]): Locale {
  if (offered.includes(site)) return site;
  return offered.includes("en") ? "en" : (offered[0] ?? "en");
}

/** What the queue is for: a class, or a stretch of time on one resource. */
export type WaitlistTarget = { classId: number; who?: "anyone" | "women" | "men" } | { courtId: number; date: string; start: number; end: number };

/**
 * Add a caller to a waiting list at the counter (app/api/admin/waitlist;
 * lib/waitlist-venue.ts): a full class, or court time somebody holds. Their
 * name and number on staff's word, as a counter booking; the people it is
 * for are the number holder and those the venue knows with a guardian on
 * that number (ParticipantPicker). The same rules as joining online; the
 * offer goes to them by message when a place frees, in the language staff
 * chose for them here.
 */
export function WaitlistJoin({
  venueId,
  target,
  label,
  onDone,
  onClose,
}: {
  venueId: number;
  target: WaitlistTarget;
  /** What it is for, as staff see it: "Court 2, 6:00 PM" or the class's name. */
  label: string;
  onDone?: (entry: WaitlistEntry, position: number) => void;
  /** Shown open, with a way to close it (the schedule); otherwise a button opens it. */
  onClose?: () => void;
}) {
  const t = useStaffT();
  const offered = offeredLocales();
  const firstLanguage = startingLanguage(useT().locale, offered);
  const [open, setOpen] = useState(onClose !== undefined);
  const [form, setForm] = useState({ name: "", phone: "", email: "" });
  // The caller's language, asked: the offer reaches them later, in it (lib/notify.ts `notifyPendingOffers`).
  const [language, setLanguage] = useState<Locale>(firstLanguage);
  const [span, setSpan] = useState("courtId" in target ? { start: target.start, end: target.end } : null);
  const [people, setPeople] = useState<PickedParticipant[]>([]);
  const [holderToo, setHolderToo] = useState(false);
  const [confirmWho, setConfirmWho] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const who = "classId" in target ? (target.who ?? "anyone") : "anyone";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          ...("classId" in target ? { classId: target.classId } : { courtId: target.courtId, date: target.date, start: span!.start, end: span!.end }),
          name: form.name,
          phone: form.phone,
          ...(form.email.trim() ? { email: form.email.trim() } : {}),
          locale: language,
          ...(people.length > 0 ? { participantIds: people.map((p) => p.id), customerTakesPart: holderToo } : {}),
          ...(who !== "anyone" ? { confirmWho } : {}),
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("wl5.failed")));
      setNotice(t("wl5.added", { n: data.position }));
      setForm({ name: "", phone: "", email: "" });
      setLanguage(firstLanguage);
      setPeople([]);
      setHolderToo(false);
      setConfirmWho(false);
      onDone?.(data.entry, data.position);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("wl5.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <div className="mt-3">
        <button type="button" onClick={() => setOpen(true)} className="rounded-md border border-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-50">
          {t("wl5.add")}
        </button>
        {notice && <p className="mt-1 text-xs text-emerald-700">{notice}</p>}
      </div>
    );

  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm">
      <div className="font-semibold text-amber-900">{t("wl5.title", { what: label })}</div>
      <p className="text-xs text-slate-600">{t("wl5.help")}</p>
      {span && (
        <div className="flex flex-wrap items-center gap-2">
          <ClockField label={t("wl5.from")} value={span.start} onChange={(m) => setSpan({ ...span, start: m })} className={input} />
          <ClockField label={t("wl5.until")} value={span.end} after={span.start} onChange={(m) => setSpan({ ...span, end: m })} className={input} />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <input required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("wl5.name")} aria-label={t("wl5.name")} className={input} />
        <input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={t("wl5.phone")} aria-label={t("wl5.phone")} className={input} />
        <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={t("wl5.email")} aria-label={t("wl5.email")} className={input} />
        {offered.length > 1 && (
          <select value={language} onChange={(e) => setLanguage(e.target.value as Locale)} aria-label={t("wl5b.language")} title={t("wl5b.language")} className={input}>
            {offered.map((code) => (
              <option key={code} value={code}>
                {LOCALE_NAMES[code]}
              </option>
            ))}
          </select>
        )}
      </div>
      <ParticipantPicker
        venueId={venueId}
        phone={form.phone}
        guardianName={form.name}
        many={{
          values: people,
          holderTakesPart: holderToo,
          onChange: (values, holder) => {
            setPeople(values);
            setHolderToo(holder);
          },
        }}
      />
      {who !== "anyone" && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={confirmWho} onChange={(e) => setConfirmWho(e.target.checked)} />
          {t(who === "women" ? "wl5.confirmWomen" : "wl5.confirmMen")}
        </label>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}
      {notice && <p className="text-xs text-emerald-700">{notice}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
          {t("wl5.submit")}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onClose?.();
          }}
          className="text-xs text-slate-500 underline"
        >
          {t("c.cancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * Who is waiting for what, and who put them there (online, the counter, the
 * API): the day's queues at a venue, or one class's. An entry the venue made
 * can be taken off here; one the customer made online is theirs to leave.
 */
export function WaitlistQueue({
  venueId,
  date,
  classId,
  entries: given,
  refreshKey = 0,
  onChange,
}: {
  venueId: number;
  /** The day's queues, fetched here. */
  date?: string;
  /** Only this class's, from `entries`. */
  classId?: number;
  entries?: WaitlistEntry[];
  /** Changed by the parent to fetch again. */
  refreshKey?: number;
  onChange?: () => void;
}) {
  const t = useStaffT();
  const [fetched, setFetched] = useState<WaitlistEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!date) return;
    try {
      const res = await fetch(`/api/admin/waitlist?venueId=${venueId}&date=${date}`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("wl5.loadFailed")));
      setFetched(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("wl5.loadFailed"));
    }
  }, [venueId, date, t]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function remove(entry: WaitlistEntry) {
    if (!window.confirm(t("wl5.removeConfirm", { name: entry.name }))) return;
    setError(null);
    try {
      const res = await fetch("/api/admin/waitlist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, entryId: entry.id }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("wl5.removeFailed")));
      await load();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("wl5.removeFailed"));
    }
  }

  const entries = (given ?? fetched ?? []).filter((e) => classId === undefined || e.classId === classId);
  // Which language each offer goes in, where there is more than one.
  const multilingual = offeredLocales().length > 1;
  if (entries.length === 0 && !error) return null;
  return (
    <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">{t("cls.waitingN", { n: entries.length })}</div>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      <ul className="mt-1 space-y-1 text-amber-900">
        {entries.map((w) => (
          <li key={w.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {w.participantNames && w.participantNames.length > 0 ? t("apr.child.bookedFor", { name: w.participantNames.join(", "), adult: w.name }) : w.name}
              <span className="ml-2 text-xs opacity-70">{w.phone}</span>
              {w.classId === null && w.startMin !== null && w.endMin !== null && (
                <span className="ml-2 text-xs opacity-70">
                  {w.label ? `${w.label.split(" · ")[0]} · ` : ""}
                  {formatMinute(w.startMin, t.locale)}–{formatMinute(w.endMin, t.locale)}
                </span>
              )}
              <span className="ml-2 text-xs opacity-70">
                {w.madeBy === "staff" ? t("wl5.madeCounter", { name: w.madeByName ?? "" }) : w.madeBy === "api" ? t("wl5.madeApi") : t("wl5.madeOnline")}
              </span>
              {multilingual && isLocale(w.locale) && <span className="ml-2 text-xs opacity-70">{t("wl5b.offerIn", { language: LOCALE_NAMES[w.locale] })}</span>}
            </span>
            <span className="flex items-center gap-2">
              {w.status === "offered" && <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold">{t("cls.offered")}</span>}
              {w.madeBy && w.madeBy !== "customer" && (
                <button type="button" onClick={() => void remove(w)} className="text-xs font-medium text-red-700 underline">
                  {t("wl5.remove")}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
