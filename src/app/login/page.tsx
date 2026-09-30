"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "login" ? { email, password } : { name, email, phone, password }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data.error ?? t("auth.failed")));
      router.push("/account");
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

      <form
        onSubmit={submit}
        className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      >
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
