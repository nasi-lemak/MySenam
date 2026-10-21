"use client";

import { useState } from "react";
import { useT } from "@/components/Language";
import { money } from "@/lib/region";
import { MAX_SPLIT_PARTS } from "@/lib/types";

/** The booker's side: how many ways, and the link to send (lib/splits.ts). */
export function SplitCost({ code, phone, total, venueName, date }: { code: string; phone: string; total: number; venueName: string; date: string }) {
  const t = useT();
  const [parts, setParts] = useState(2);
  const [link, setLink] = useState<{ url: string; share: number; paid: number; parts: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const share = Math.floor((total / parts) * 100) / 100;

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings/split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, phone, parts }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setLink({ url: data.url, share: data.split.share, paid: data.split.paid, parts: data.split.parts });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const message = link ? t("split.message", { venue: venueName, date, share: money(link.share), link: link.url }) : "";
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">
      <p className="font-semibold">{t("split.title")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          {t("split.ways")}
          <select value={parts} onChange={(e) => setParts(Number(e.target.value))} className="rounded-md border border-slate-300 px-2 py-1">
            {Array.from({ length: MAX_SPLIT_PARTS - 1 }, (_, i) => i + 2).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={busy} onClick={() => void make()} className="rounded-md border border-teal-600 px-3 py-1 font-medium text-teal-700 disabled:opacity-50">
          {t("split.make")}
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-600">{t("split.each", { share: money(share), rest: money(Math.round((total - share * (parts - 1)) * 100) / 100) })}</p>
      <p className="mt-1 text-xs text-amber-800">{t("split.terms")}</p>
      {error && <p className="mt-2 text-rose-700">{error}</p>}
      {link && (
        <div className="mt-2 space-y-1">
          <p>{t("split.link")}</p>
          <p className="break-all rounded bg-slate-50 p-2 font-mono text-xs">{link.url}</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="font-medium text-teal-700 underline" onClick={() => void navigator.clipboard?.writeText(link.url)}>
              {t("split.copy")}
            </button>
            <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener" className="font-medium text-teal-700 underline">
              {t("split.whatsapp")}
            </a>
          </div>
          <p className="text-xs text-slate-500">{t("split.progress", { paid: link.paid, of: link.parts - 1 })}</p>
        </div>
      )}
    </div>
  );
}

/** A friend's side: name and number, then the venue's payment page. */
export function SplitPay({ token }: { token: string }) {
  const t = useT();
  const [who, setWho] = useState({ name: "", phone: "", email: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const res = await fetch(`/api/split/${token}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(who),
        }).catch(() => null);
        const data = res ? await res.json().catch(() => ({})) : {};
        if (res?.ok && data.url) window.location.href = data.url;
        else {
          setError(data.error ?? t("pay.failed"));
          setBusy(false);
        }
      }}
    >
      <input aria-label={t("form.name")} placeholder={t("form.name")} required minLength={2} value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} className={input} />
      <input aria-label={t("form.phone")} placeholder={t("form.phone")} required type="tel" value={who.phone} onChange={(e) => setWho({ ...who, phone: e.target.value })} className={input} />
      <input aria-label={t("form.emailOptional")} placeholder={t("form.emailOptional")} type="email" value={who.email} onChange={(e) => setWho({ ...who, email: e.target.value })} className={input} />
      {error && <p className="text-rose-700">{error}</p>}
      <button type="submit" disabled={busy} className="w-full rounded-md bg-teal-600 py-2 font-semibold text-white disabled:opacity-50">
        {busy ? t("split.paying") : t("split.pay")}
      </button>
    </form>
  );
}
