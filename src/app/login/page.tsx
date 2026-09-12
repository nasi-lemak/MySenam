"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
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
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      router.push("/account");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  const inputClass =
    "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none";

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          {mode === "login" ? "Welcome back" : "Create an account"}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {mode === "login"
            ? "Sign in to see and manage your bookings."
            : "Register to keep all your bookings in one place."}
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
            {m === "login" ? "Sign in" : "Register"}
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
              Name
              <input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ali bin Abu" className={inputClass} />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Phone
              <input required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="012-345 6789" className={inputClass} />
            </label>
          </>
        )}
        <label className="block text-sm font-medium text-slate-700">
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={inputClass} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Password
          <input type="password" required minLength={mode === "register" ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "register" ? "At least 8 characters" : "Password"} className={inputClass} />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </div>
  );
}
