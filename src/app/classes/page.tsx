"use client";

import { accountDetour } from "@/lib/phone-detour";
import { useCallback, useEffect, useState } from "react";
import AddonPicker, { pickedList, pickedTotal, type OfferedAddon, type Picked } from "@/components/AddonPicker";
import { forgetGuest, rememberedGuest, rememberGuest } from "@/lib/guest-memory";
import ChatLink from "@/components/ChatLink";
import { formatHour } from "@/lib/time";
import { ClassSession, Sport, SPORTS, SPORT_ICONS } from "@/lib/types";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { sportLabel } from "@/lib/i18n";
import type { T } from "@/lib/i18n";
import { money, intlTag } from "@/lib/region";

function dateLabel(t: T, date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(intlTag(t.locale), {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export default function ClassesPage() {
  const t = useT();
  const [sport, setSport] = useState<Sport | "">("");
  const [classes, setClasses] = useState<ClassSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<ClassSession | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/classes${sport ? `?sport=${sport}` : ""}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("classes.loadFailed"));
      setClasses(data.classes);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("classes.loadFailed"));
      setClasses(null);
    }
  }, [sport, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Classes read best grouped by the day they fall on.
  const byDate = new Map<string, ClassSession[]>();
  for (const session of classes ?? []) {
    byDate.set(session.date, [...(byDate.get(session.date) ?? []), session]);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("classes.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {t("classes.intro")}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setSport("")}
          className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
            sport === ""
              ? "bg-teal-600 text-white shadow"
              : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"
          }`}
        >
          {t("classes.all")}
        </button>
        {SPORTS.map((s) => (
          <button
            key={s}
            onClick={() => setSport(s)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              s === sport
                ? "bg-teal-600 text-white shadow"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"
            }`}
          >
            {SPORT_ICONS[s]} {sportLabel(t, s)}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {classes === null ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          {t("classes.loading")}
        </div>
      ) : classes.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          {sport
            ? t("classes.noneFor", { sport: sportLabel(t, sport).toLowerCase() })
            : t("classes.none")}
        </div>
      ) : (
        <div className="space-y-6">
          {[...byDate.entries()].map(([date, sessions]) => (
            <section key={date}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                {dateLabel(t, date)}
              </h2>
              <ul className="mt-2 space-y-2">
                {sessions.map((session) => {
                  const left = session.capacity - session.enrolled;
                  return (
                    <li
                      key={session.id}
                      className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                    >
                      <div className="w-28 shrink-0 font-semibold text-teal-700">
                        {formatHour(session.startHour)}
                        <div className="text-xs font-normal text-slate-400">
                          {t("classes.to", { time: formatHour(session.endHour) })}
                        </div>
                      </div>
                      <div className="min-w-[12rem] flex-1">
                        <div className="font-medium">
                          {SPORT_ICONS[session.sport]} {session.name}
                          {session.who !== "anyone" && (
                            <span className="ml-2 rounded-full bg-fuchsia-50 px-2 py-0.5 text-xs font-medium text-fuchsia-800">
                              {t(`who.badge.${session.who}`)}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-slate-500">
                          {t("classes.with", {
                            instructor: session.instructor,
                            venue: session.venueName,
                            area: session.venueArea,
                          })}
                        </div>
                      </div>
                      <div className="text-right text-sm">
                        <div className="font-bold">{session.price === 0 ? t("price.free") : `${money(session.price)}`}</div>
                        <div className={left === 0 ? "text-xs text-red-600" : "text-xs text-slate-400"}>
                          {left === 0
                            ? t("classes.full")
                            : t("classes.left", { left, capacity: session.capacity })}
                        </div>
                      </div>
                      <button
                        onClick={() => setEnrolling(session)}
                        className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                          left === 0
                            ? "border border-teal-600 text-teal-700 hover:bg-teal-50"
                            : "bg-teal-600 text-white hover:bg-teal-700"
                        }`}
                      >
                        {left === 0 ? t("classes.joinWaitlist") : t("classes.enrol")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {enrolling && (
        <EnrolModal
          t={t}
          session={enrolling}
          onClose={() => setEnrolling(null)}
          onDone={() => {
            setEnrolling(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function EnrolModal({
  t,
  session,
  onClose,
  onDone,
}: {
  t: T;
  session: ClassSession;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [queued, setQueued] = useState<number | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [confirmWho, setConfirmWho] = useState(false);
  const [remembered, setRemembered] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked>({});
  const [offered, setOffered] = useState<OfferedAddon[]>([]);
  const [extrasNote, setExtrasNote] = useState<string | null>(null);
  const [chat, setChat] = useState<string | null>(null);
  const isFull = session.enrolled >= session.capacity;
  const total = Math.round((session.price + pickedTotal(offered, picked)) * 100) / 100;

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!data.user) {
          const guest = rememberedGuest();
          if (guest) {
            setName((v) => v || guest.name);
            setPhone((v) => v || guest.phone);
            setEmail((v) => v || guest.email);
            setRemembered(guest.name);
          }
          return;
        }
        setSignedIn(true);
        setName((v) => v || data.user.name);
        setPhone((v) => v || data.user.phone);
        setEmail((v) => v || data.user.email);
      })
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(isFull ? "/api/waitlist" : "/api/classes/enrol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classId: session.id,
          name,
          phone,
          email,
          confirmWho,
          ...(isFull ? {} : { addons: pickedList(picked) }),
        }),
      });
      const data = await res.json();
      if (!res.ok && accountDetour(data)) return;
      if (!res.ok)
        throw new Error(
          translateError(t, data) || (isFull ? t("classes.joinFailed") : t("classes.enrolFailed"))
        );
      if (!signedIn) rememberGuest({ name, phone, email });
      if (isFull) setQueued(data.position);
      else {
        setCode(data.booking.code);
        setChat(data.chatNumber ?? null);
        if (data.addonError) setExtrasNote(t("done.addonRejected", { reason: translateError(t, data.addonError) }));
        else if (data.addons?.length)
          setExtrasNote(
            `${t("done.extras")}: ${(data.addons as { name: string; quantity: number }[]).map((a) => `${a.quantity} × ${a.name}`).join(", ")} · ${t("done.total")} ${money(data.booking.totalPrice)}`
          );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.failed"));
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        {queued !== null ? (
          <div className="text-center">
            <div className="text-4xl">⏳</div>
            <h2 className="mt-2 text-xl font-bold">{t("classes.queuedTitle")}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {t("classes.queuedBody", { position: queued, name: session.name })}
            </p>
            <p className="mt-3 text-xs text-slate-500">
              {t("classes.queuedNote")}
            </p>
            <button
              onClick={onDone}
              className="mt-5 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
            >
              {t("done.close")}
            </button>
          </div>
        ) : code ? (
          <div className="text-center">
            <div className="text-4xl">✅</div>
            <h2 className="mt-2 text-xl font-bold">{t("classes.enrolledTitle")}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {t("classes.enrolledWith", {
                name: session.name,
                instructor: session.instructor,
              })}
            </p>
            <div className="mt-4 rounded-xl bg-teal-50 py-3 text-2xl font-bold tracking-widest text-teal-700">
              {code}
            </div>
            {extrasNote && <p className="mt-2 text-xs text-slate-600">{extrasNote}</p>}
            <ChatLink t={t} number={chat} code={code} />
            <p className="mt-2 text-xs text-slate-500">
              {t("classes.enrolledNote")}
            </p>
            <button
              onClick={onDone}
              className="mt-5 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
            >
              {t("done.close")}
            </button>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-bold">{session.name}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {t("classes.summary", {
                from: formatHour(session.startHour),
                to: formatHour(session.endHour),
                instructor: session.instructor,
                price: session.price,
              })}
            </p>
            {isFull && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {t("classes.fullNote")}
              </p>
            )}
            <form onSubmit={submit} className="mt-4 space-y-3">
              {remembered && (
                <button
                  type="button"
                  onClick={() => {
                    forgetGuest();
                    setRemembered(null);
                    setName("");
                    setPhone("");
                    setEmail("");
                  }}
                  className="text-xs text-slate-500 underline"
                >
                  {t("guest.notYou", { name: remembered })}
                </button>
              )}
              <label className="block text-sm font-medium text-slate-700">
                {t("form.name")}
                <input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                {t("form.phone")}
                <input required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t("auth.phonePlaceholder")} className={inputClass} />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                {t("form.emailOptional")}
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
              </label>
              {/* A guest says it for themselves; an account has said it already. */}
              {session.who !== "anyone" && !signedIn && (
                <label className="flex items-start gap-2 rounded-lg bg-fuchsia-50 p-3 text-sm text-fuchsia-900">
                  <input type="checkbox" required checked={confirmWho} onChange={(e) => setConfirmWho(e.target.checked)} className="mt-0.5" />
                  {t(`who.confirm.${session.who}`)}
                </label>
              )}
              {!isFull && (
                <AddonPicker t={t} query={`classId=${session.id}`} picked={picked} onChange={setPicked} onList={setOffered} />
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-lg border border-slate-300 py-2 text-sm font-medium text-slate-600 hover:border-slate-400"
                >
                  {t("queue.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="flex-1 rounded-lg bg-teal-600 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  {busy
                    ? isFull
                      ? t("classes.joining")
                      : t("classes.enrolling")
                    : isFull
                      ? t("classes.joinWaitlist")
                      : t("classes.enrolPrice", { price: total })}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
