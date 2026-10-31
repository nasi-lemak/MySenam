"use client";

import { readJson } from "@/lib/read-response";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useT } from "@/components/Language";
import PinPicker from "@/components/PinPicker";
import type { MapPoint } from "@/components/PinMap";
import { sportLabel, translateError } from "@/lib/i18n";
import { businessType } from "@/lib/guide/business-types";
import { decodeFit, guideAddress, selectionOf } from "@/lib/guide/public/select";

const EMPTY = {
  businessName: "",
  area: "",
  address: "",
  venuePhone: "",
  contactName: "",
  email: "",
  password: "",
  message: "",
  website: "",
};

export default function ApplyForm() {
  const t = useT();
  const [form, setForm] = useState(EMPTY);
  const [pin, setPin] = useState<MapPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ to: string; confirm: boolean } | null>(null);
  // What the visitor chose in the public guide (`?fit=`): shown back, sent with the application, never asked twice.
  const raw = useSearchParams()?.get("fit");
  const fit = useMemo(() => decodeFit(raw), [raw]);
  const [leaveFitOut, setLeaveFitOut] = useState(false);
  const sendFit = leaveFitOut ? null : fit;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!pin) return setError(t("apply.needPin"));
    setBusy(true);
    try {
      const res = await fetch("/api/venue-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, ...pin, ...(sendFit ? { fit: sendFit } : {}) }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data) || t("apply.failed"));
      setSent({ to: form.email, confirm: data.emailSent !== false });
      setForm(EMPTY);
      setPin(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("apply.failed"));
    } finally {
      setBusy(false);
    }
  }

  const input =
    "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none";
  const field = (key: keyof typeof EMPTY, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block text-sm font-medium text-slate-700">
      {label}
      <input
        required
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className={input}
        {...props}
      />
    </label>
  );

  if (sent)
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="text-4xl">📨</div>
        <h1 className="mt-2 text-xl font-bold">{t(sent.confirm ? "apply.checkTitle" : "apply.doneTitle")}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {t(sent.confirm ? "apply.checkBody" : "apply.doneBody", { email: sent.to })}
        </p>
        {!sent.confirm && (
          <Link
            href="/admin"
            className="mt-4 inline-block rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
          >
            {t("apply.signIn")}
          </Link>
        )}
      </div>
    );

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <div>
        <h1 className="text-2xl font-bold">{t("apply.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {t("apply.intro")}{" "}
          <Link href="/pricing" className="font-medium text-teal-700 underline">
            {t("pricing.see")}
          </Link>
        </p>
      </div>
      {sendFit && (
        <section aria-labelledby="fit-told" className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm">
          <p id="fit-told" className="m-0 font-medium text-slate-900">
            {t("fit.told", {
              list: new Intl.ListFormat(t.locale === "zh" ? "zh-Hans" : t.locale, { style: "long", type: "conjunction" }).format([
                ...selectionOf(sendFit).types.map((id) => t(businessType(id)!.titleKey)),
                ...selectionOf(sendFit).activities.map((key) => sportLabel(t, key)),
              ]),
            })}
          </p>
          <p className="m-0 mt-1 text-slate-600">{t("fit.told.note")}</p>
          <p className="m-0 mt-2 flex flex-wrap items-center gap-3">
            <Link href={guideAddress(selectionOf(sendFit))} className="inline-flex min-h-9 items-center font-medium text-teal-800 underline">
              {t("fit.told.change")}
            </Link>
            <button type="button" onClick={() => setLeaveFitOut(true)} className="inline-flex min-h-9 items-center rounded-md px-2 font-medium text-slate-700 underline">
              {t("fit.told.leave")}
            </button>
          </p>
        </section>
      )}
      <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        {field("businessName", t("apply.business"), { maxLength: 100 })}
        <div className="grid gap-4 sm:grid-cols-2">
          {field("area", t("apply.area"), { maxLength: 60 })}
          {field("venuePhone", t("apply.venuePhone"), { type: "tel", maxLength: 20 })}
        </div>
        {field("address", t("apply.address"), { maxLength: 200 })}
        <PinPicker
          query={[form.address, form.area].filter((v) => v.trim()).join(", ")}
          pin={pin}
          onPin={setPin}
          text={{
            label: t("apply.mapLabel"),
            hint: t("apply.mapHint"),
            find: t("apply.findAddress"),
            useLocation: t("apply.useLocation"),
            looking: t("apply.looking"),
            found: t("apply.found"),
            notFound: t("apply.notFound"),
            pinned: t("apply.pinned"),
            locationFailed: t("apply.locationFailed"),
          }}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {field("contactName", t("apply.contactName"), { maxLength: 100, autoComplete: "name" })}
          {field("email", t("apply.email"), { type: "email", maxLength: 200, autoComplete: "email" })}
        </div>
        <div>
          {field("password", t("apply.password"), {
            type: "password",
            minLength: 10,
            maxLength: 200,
            autoComplete: "new-password",
          })}
          <p className="mt-1 text-xs text-slate-500">{t("apply.passwordHint")}</p>
        </div>
        <label className="block text-sm font-medium text-slate-700">
          {t("apply.message")}
          <textarea
            value={form.message}
            onChange={(e) => setForm({ ...form, message: e.target.value })}
            maxLength={2000}
            rows={3}
            className={input}
          />
        </label>
        {/* Nobody sees this; a script filling every field fills it too. */}
        <input
          tabIndex={-1}
          aria-hidden
          autoComplete="off"
          value={form.website}
          onChange={(e) => setForm({ ...form, website: e.target.value })}
          className="hidden"
          name="website"
        />
        <p className="text-xs text-slate-500">
          {t("apply.agree")}{" "}
          <Link href="/terms#venues" className="underline">
            {t("apply.termsLink")}
          </Link>
          .
        </p>
        {error && <p className="text-sm font-medium text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? t("apply.sending") : t("apply.submit")}
        </button>
      </form>
    </div>
  );
}
