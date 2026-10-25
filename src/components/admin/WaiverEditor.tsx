"use client";

import { useEffect, useState } from "react";
import { useStaffT } from "./StaffLanguage";

/**
 * The venue's waiver (lib/waivers.ts): the words customers agree to before
 * they book. Changing them asks everybody to agree afresh; empty asks for none.
 */
export function WaiverEditor({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<{ since: string | null; signed: number }>({ since: null, signed: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function take(data: { waiver: { text: string; createdAt: string } | null; signed: number }) {
    setText(data.waiver?.text ?? "");
    setSaved({ since: data.waiver?.createdAt.slice(0, 10) ?? null, signed: data.signed });
  }

  useEffect(() => {
    if (!open) return;
    void fetch(`/api/admin/waiver?venueId=${venueId}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && take(data));
  }, [open, venueId]);

  async function save() {
    if (saved.since && !confirm(t("wv.confirm"))) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch("/api/admin/waiver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, text }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setError(t.err(data, t("vn.couldNotSave")));
    take(data);
    setNotice(data.waiver ? t("wv.saved") : t("wv.none"));
  }

  return (
    <div className="mt-3">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
        {open ? t("wv.hide") : t("wv.show")}
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">{t("wv.intro")}</p>
          {saved.since && (
            <p className="text-xs text-slate-600">{t.plural("wv.agreed", saved.signed, { since: saved.since })}</p>
          )}
          <textarea
            aria-label={t("wv.label")}
            rows={8}
            maxLength={8000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("wv.placeholder")}
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
          <button disabled={busy} onClick={save} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {t("c.save")}
          </button>
          {error && <p className="text-sm font-medium text-red-700">{error}</p>}
          {notice && <p className="text-sm font-medium text-emerald-700">{notice}</p>}
        </div>
      )}
    </div>
  );
}
