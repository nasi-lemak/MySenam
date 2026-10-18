"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { GENDERS, type Gender } from "@/lib/who-shared";

/**
 * Which games the player plays in, for women-only and men-only games,
 * classes, leagues and tournament categories; then back to what asked.
 */
export default function AboutPage() {
  const t = useT();
  const [gender, setGender] = useState<Gender | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const next = (() => {
    if (typeof window === "undefined") return "/account";
    const n = new URLSearchParams(window.location.search).get("next");
    return n && n.startsWith("/") && !n.startsWith("//") ? n : "/account";
  })();

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/my/about", { cache: "no-store" });
      if (res.status === 401) return setSignedOut(true);
      setGender((await res.json()).gender);
      setLoaded(true);
    })();
  }, []);

  if (signedOut)
    return (
      <Link href="/login?next=/account/about" className="text-teal-700 underline">
        {t("nav.signIn")}
      </Link>
    );
  if (!loaded) return null;
  return (
    <div className="mx-auto max-w-sm space-y-5">
      <div>
        <h1 className="text-2xl font-bold">{t("about.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("about.intro")}</p>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!gender) return;
          setBusy(true);
          const res = await fetch("/api/my/about", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gender }) });
          if (res.ok) window.location.href = next;
          else setBusy(false);
        }}
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        {GENDERS.map((g) => (
          <label key={g} className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm has-[:checked]:border-teal-500 has-[:checked]:bg-teal-50">
            <input type="radio" name="gender" value={g} checked={gender === g} onChange={() => setGender(g)} className="mt-0.5" />
            <span>
              <span className="font-medium">{t(`about.${g}`)}</span>
              {g === "unsaid" && <span className="block text-xs text-slate-500">{t("about.unsaidNote")}</span>}
            </span>
          </label>
        ))}
        <button disabled={!gender || busy} className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
          {t("about.save")}
        </button>
      </form>
    </div>
  );
}
