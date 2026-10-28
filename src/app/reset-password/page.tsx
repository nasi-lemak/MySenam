"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";

/**
 * Where the emailed link lands: choose a new password, and be signed in.
 * The token is read from the address, not sent anywhere until the form is.
 */
export default function ResetPasswordPage() {
  const t = useT();
  const [kind, setKind] = useState<"user" | "admin">("user");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("kind") === "admin") setKind("admin");
    setToken(params.get("token") ?? "");
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(kind === "admin" ? "/api/admin/auth/reset" : "/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data) || t("auth.failed"));
      setDone(true);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.failed"));
    } finally {
      setBusy(false);
    }
  }

  const home = kind === "admin" ? "/admin" : "/account";
  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-2xl font-bold">{t("reset.newTitle")}</h1>
      {done ? (
        <div className="space-y-4">
          <p role="status" className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-800">
            {t("reset.done")}
          </p>
          <a href={home} className="block w-full rounded-lg bg-teal-600 py-2.5 text-center font-semibold text-white hover:bg-teal-700">
            {t("reset.continue")}
          </a>
        </div>
      ) : (
        <form onSubmit={save} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <label className="block text-sm font-medium text-slate-700">
            {t("reset.newPassword")}
            <input
              type="password"
              required
              autoFocus
              minLength={8}
              maxLength={200}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("auth.passwordHint")}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? t("auth.working") : t("reset.save")}
          </button>
          {error && (
            <p className="text-sm text-red-600">
              {error}{" "}
              <a href={`/forgot-password${kind === "admin" ? "?kind=admin" : ""}`} className="underline">
                {t("reset.forgot")}
              </a>
            </p>
          )}
        </form>
      )}
    </div>
  );
}
