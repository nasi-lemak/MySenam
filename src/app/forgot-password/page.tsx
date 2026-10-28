"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";

/** Ask for a link to set a new password. `?kind=admin` is for venue staff. */
export default function ForgotPasswordPage() {
  const t = useT();
  const [kind, setKind] = useState<"user" | "admin">("user");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("kind") === "admin") setKind("admin");
  }, []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(kind === "admin" ? "/api/admin/auth/forgot" : "/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data) || t("auth.failed"));
      setSentTo(email.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("reset.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("reset.intro")}</p>
      </div>
      {sentTo ? (
        <p role="status" className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-800">
          {t("reset.sent", { email: sentTo })}
        </p>
      ) : (
        <form onSubmit={send} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <label className="block text-sm font-medium text-slate-700">
            {t("auth.email")}
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? t("auth.working") : t("reset.send")}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      )}
      <a href={kind === "admin" ? "/admin" : "/login"} className="block text-center text-sm text-teal-700 underline">
        {t("reset.back")}
      </a>
    </div>
  );
}
