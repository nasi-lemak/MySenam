"use client";

import { readJson } from "@/lib/read-response";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { SIGN_UP_NEXT } from "@/lib/registration-shared";

/**
 * Where an emailed sign-up link lands (lib/registration.ts): the address it
 * proved, then the name, phone number and password the account needs. The
 * token is read from the address and sent only in a request's body. A link
 * that cannot be used gets the one neutral answer, which says to sign in or
 * ask for a new link.
 */
export default function RegisterPage() {
  const router = useRouter();
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [dead, setDead] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const found = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(found);
    if (!found) return;
    void fetch("/api/auth/register/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: found }) })
      .then(async (res) => {
        const data = await readJson(res);
        if (res.ok) setEmail(String(data.email));
        else setDead(translateError(t, data) || t("auth.failed"));
      })
      .catch(() => setDead(t("auth.failed")));
  }, [t]);

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/register/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name, phone, password }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        if (data?.code === "REGISTRATION_INVALID") {
          setDead(translateError(t, data));
          setBusy(false);
          return;
        }
        throw new Error(translateError(t, data) || t("auth.failed"));
      }
      router.push(takeNext());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.failed"));
      setBusy(false);
    }
  }

  const inputClass = "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none";
  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-2xl font-bold">{t("su7.finishTitle")}</h1>
      {token === "" ? (
        <p role="alert" className="text-sm text-red-600">{t("su7.noToken")}</p>
      ) : dead ? (
        <div className="space-y-4">
          <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {dead}
          </p>
          <a href="/login" className="block w-full rounded-lg bg-teal-600 py-2.5 text-center font-semibold text-white hover:bg-teal-700">
            {t("su7.signIn")}
          </a>
          <a href="/login?mode=register" className="block text-center text-sm text-teal-700 underline">
            {t("su7.startAgain")}
          </a>
        </div>
      ) : email === null ? (
        <p role="status" className="text-sm text-slate-600">{t("su7.checking")}</p>
      ) : (
        <form onSubmit={finish} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-600">{t("su7.finishIntro", { email })}</p>
          <label className="block text-sm font-medium text-slate-700">
            {t("auth.name")}
            <input required minLength={2} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("auth.namePlaceholder")} className={inputClass} />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            {t("auth.phone")}
            <input required type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t("auth.phonePlaceholder")} className={inputClass} />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            {t("auth.password")}
            <input type="password" required minLength={8} maxLength={200} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("auth.passwordHint")} className={inputClass} />
          </label>
          <button type="submit" disabled={busy} className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
            {busy ? t("auth.working") : t("auth.creating")}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      )}
    </div>
  );
}

/** Where the sign-up started from, if it was in this browser (src/app/login/page.tsx); else the account page. Used once. */
function takeNext(): string {
  try {
    const next = window.localStorage.getItem(SIGN_UP_NEXT);
    window.localStorage.removeItem(SIGN_UP_NEXT);
    if (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")) return next;
  } catch {
    // No storage: the account page.
  }
  return "/account";
}
