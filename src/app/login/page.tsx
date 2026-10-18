"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  // Nobody sees this field; a script filling in every field fills it too.
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);

  // Whether this address offers Google; and a sign-in that came back refused says why.
  useEffect(() => {
    const failed = new URLSearchParams(window.location.search).get("error");
    if (failed) setError(failed === "google" ? t("auth.failed") : failed);
    void fetch("/api/auth/providers", { cache: "no-store" })
      .then((r) => r.json())
      .then((p: { google?: boolean }) => setGoogle(Boolean(p.google)))
      .catch(() => {});
  }, [t]);
  const nextParam = () => {
    const next = new URLSearchParams(window.location.search).get("next");
    return next && next.startsWith("/") && !next.startsWith("//") ? next : "/account";
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "login" ? { email, password } : { name, email, phone, password, website }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("auth.failed"));
      // Back where they were, if they were sent here from somewhere on this site.
      router.push(nextParam());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.failed"));
      setBusy(false);
    }
  }

  const inputClass =
    "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none";

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          {mode === "login" ? t("auth.welcomeBack") : t("auth.createAccount")}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {mode === "login"
            ? t("auth.signInIntro")
            : t("auth.registerIntro")}
        </p>
      </div>

      <div className="flex rounded-lg bg-slate-100 p-1 text-sm font-medium">
        {(["login", "register"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={`flex-1 rounded-md py-1.5 transition ${
              mode === m ? "bg-white text-teal-700 shadow" : "text-slate-500"
            }`}
          >
            {m === "login" ? t("auth.signIn") : t("auth.register")}
          </button>
        ))}
      </div>

      {google && (
        <div className="space-y-3">
          <a
            href="/api/auth/google"
            onClick={(e) => {
              e.preventDefault();
              window.location.href = `/api/auth/google?next=${encodeURIComponent(nextParam())}`;
            }}
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white py-2.5 font-semibold text-slate-700 shadow-sm hover:border-slate-400"
          >
            <svg aria-hidden width="18" height="18" viewBox="0 0 48 48">
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
            </svg>
            {t("auth.google")}
          </a>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="h-px flex-1 bg-slate-200" />
            {t("auth.or")}
            <span className="h-px flex-1 bg-slate-200" />
          </div>
        </div>
      )}

      <form
        onSubmit={submit}
        className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <input
          tabIndex={-1}
          aria-hidden
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          className="hidden"
          name="website"
        />
        {mode === "register" && (
          <>
            <label className="block text-sm font-medium text-slate-700">
              {t("auth.name")}
              <input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("auth.namePlaceholder")} className={inputClass} />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              {t("auth.phone")}
              <input required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t("auth.phonePlaceholder")} className={inputClass} />
            </label>
          </>
        )}
        <label className="block text-sm font-medium text-slate-700">
          {t("auth.email")}
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("auth.emailPlaceholder")} className={inputClass} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          {t("auth.password")}
          <input type="password" required minLength={mode === "register" ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "register" ? t("auth.passwordHint") : t("auth.password")} className={inputClass} />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? t("auth.working") : mode === "login" ? t("auth.signIn") : t("auth.creating")}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </div>
  );
}
