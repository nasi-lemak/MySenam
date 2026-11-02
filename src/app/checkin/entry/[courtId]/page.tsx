"use client";

import { readJson } from "@/lib/read-response";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError, type Phrase } from "@/lib/i18n";
import type { EntryOptions } from "@/lib/entries";
import type { Busyness } from "@/lib/types";
import { intlTag, region } from "@/lib/region";

interface Info {
  resource: { courtId: number; name: string; selfCheckIn: boolean };
  venue: { id: number; name: string; area: string };
  level: Busyness;
  signedIn: boolean;
  mine: EntryOptions | null;
}

/**
 * Letting yourself in where no booking is needed (lib/entries.ts): the page
 * the resource's check-in code opens. Signed in, the customer sees what of
 * their own lets them in (a membership that admits, a pass, a day pass) and
 * checks in with it; nothing is paid here. Where the venue does not let
 * customers check themselves in, it says to go to the desk.
 */
export default function EntryCheckInPage({ params }: { params: Promise<{ courtId: string }> }) {
  const { courtId } = use(params);
  const t = useT();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; stayUntil: string } | null>(null);
  const [waiver, setWaiver] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/entries?courtId=${encodeURIComponent(courtId)}`, { cache: "no-store" });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(translateError(t, data) || t("nbk.ci.failed"));
    setInfo(data);
  }, [courtId, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function checkIn(by: { by: "membership" } | { by: "pass"; passId: number }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courtId: Number(courtId), agreeWaiver: waiver, ...by }),
      });
      const data = await readJson(res).catch(() => ({}));
      if (!res.ok) throw new Error(translateError(t, data) || t("nbk.ci.failed"));
      setDone({ name: data.admission.name.split(" ")[0], stayUntil: data.admission.stayUntil });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("nbk.ci.failed"));
    } finally {
      setBusy(false);
    }
  }

  const button = "w-full rounded-lg border border-teal-300 px-3 py-2 text-left text-sm font-medium text-teal-800 hover:bg-teal-50 disabled:opacity-50";
  const mine = info?.mine;
  const nothing = mine && !mine.membership && mine.passes.length === 0;

  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {!info && !error && <p className="py-8 text-center text-slate-500">{t("nbk.ci.working")}</p>}
        {info && (
          <>
            <h1 className="text-xl font-bold">{t("nbk.ci.title", { name: info.resource.name })}</h1>
            <p className="text-sm text-slate-600">
              {info.venue.name} ({info.venue.area}) · {t("nbk.now", { level: t(`busy.${info.level}` as Phrase) })}
            </p>
            {done ? (
              <div className="mt-4" role="status">
                <p className="text-lg font-semibold text-teal-800">{t("nbk.ci.done", { name: done.name })}</p>
                <p className="mt-1 text-sm text-slate-600">
                  {t("nbk.ci.until", {
                    time: new Date(done.stayUntil).toLocaleTimeString(intlTag(t.locale), { hour: "2-digit", minute: "2-digit", timeZone: region().timeZone }),
                  })}
                </p>
              </div>
            ) : !info.resource.selfCheckIn ? (
              <p className="mt-4 text-sm text-slate-700">{t("nbk.ci.off")}</p>
            ) : !info.signedIn ? (
              <p className="mt-4 text-sm text-slate-700">
                {t("nbk.ci.signIn")}{" "}
                <Link href={`/login?next=${encodeURIComponent(`/checkin/entry/${courtId}`)}`} className="font-semibold text-teal-800 underline">
                  {t("nbk.ci.signInLink")}
                </Link>
              </p>
            ) : mine?.alreadyIn ? (
              <p className="mt-4 text-sm font-medium text-teal-800">{t("nbk.ci.already")}</p>
            ) : nothing ? (
              <p className="mt-4 text-sm text-slate-700">{t("nbk.ci.none")}</p>
            ) : (
              <div className="mt-4 space-y-2">
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={waiver} onChange={(e) => setWaiver(e.target.checked)} />
                  {t("nbk.ci.waiver")}
                </label>
                {mine?.membership && (
                  <button type="button" disabled={busy} onClick={() => void checkIn({ by: "membership" })} className={button}>
                    {t("nbk.ci.use")}: {t("nbk.ci.membership", { code: mine.membership.code, plan: mine.membership.plan })}
                  </button>
                )}
                {mine?.passes.map((p) => (
                  <button key={p.id} type="button" disabled={busy} onClick={() => void checkIn({ by: "pass", passId: p.id })} className={button}>
                    {t("nbk.ci.use")}:{" "}
                    {p.dayPass
                      ? p.usedToday
                        ? t("nbk.ci.dayUsed", { name: p.name, code: p.code })
                        : t("nbk.ci.dayNew", { name: p.name, code: p.code })
                      : t("nbk.ci.pass", { name: p.name, code: p.code, n: p.remaining })}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {error && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <Link href={info ? `/venue/${info.venue.id}` : "/"} className="mt-5 inline-block text-sm font-medium text-teal-700 underline">
          {t("checkin.back")}
        </Link>
      </div>
    </div>
  );
}
