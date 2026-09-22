"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import { ClassSession, Sport, SPORTS, SPORT_ICONS, SPORT_LABELS } from "@/lib/types";

function dateLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-MY", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export default function ClassesPage() {
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
      if (!res.ok) throw new Error(data.error ?? "Failed to load classes");
      setClasses(data.classes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load classes");
      setClasses(null);
    }
  }, [sport]);

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
        <h1 className="text-2xl font-bold">Classes</h1>
        <p className="mt-1 text-sm text-slate-600">
          Instructor-led sessions you join rather than book a court for.
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
          All
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
            {SPORT_ICONS[s]} {SPORT_LABELS[s]}
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
          Loading…
        </div>
      ) : classes.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          No upcoming classes{sport ? ` for ${SPORT_LABELS[sport].toLowerCase()}` : ""}.
        </div>
      ) : (
        <div className="space-y-6">
          {[...byDate.entries()].map(([date, sessions]) => (
            <section key={date}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                {dateLabel(date)}
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
                          to {formatHour(session.endHour)}
                        </div>
                      </div>
                      <div className="min-w-[12rem] flex-1">
                        <div className="font-medium">
                          {SPORT_ICONS[session.sport]} {session.name}
                        </div>
                        <div className="text-sm text-slate-500">
                          with {session.instructor} · {session.venueName} ({session.venueArea})
                        </div>
                      </div>
                      <div className="text-right text-sm">
                        <div className="font-bold">RM{session.price}</div>
                        <div className={left === 0 ? "text-xs text-red-600" : "text-xs text-slate-400"}>
                          {left === 0 ? "Full" : `${left} of ${session.capacity} left`}
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
                        {left === 0 ? "Join waitlist" : "Enrol"}
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
  session,
  onClose,
  onDone,
}: {
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
  const isFull = session.enrolled >= session.capacity;

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!data.user) return;
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
        body: JSON.stringify({ classId: session.id, name, phone, email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? (isFull ? "Could not join" : "Enrolment failed"));
      if (isFull) setQueued(data.position);
      else setCode(data.booking.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
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
            <h2 className="mt-2 text-xl font-bold">You&apos;re on the waitlist</h2>
            <p className="mt-1 text-sm text-slate-600">
              Number {queued} in the queue for {session.name}.
            </p>
            <p className="mt-3 text-xs text-slate-500">
              If someone cancels, the place is offered to whoever has waited longest. Signed-in
              customers see the offer on their account page.
            </p>
            <button
              onClick={onDone}
              className="mt-5 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
            >
              Done
            </button>
          </div>
        ) : code ? (
          <div className="text-center">
            <div className="text-4xl">✅</div>
            <h2 className="mt-2 text-xl font-bold">You&apos;re enrolled</h2>
            <p className="mt-1 text-sm text-slate-600">
              {session.name} with {session.instructor}
            </p>
            <div className="mt-4 rounded-xl bg-teal-50 py-3 text-2xl font-bold tracking-widest text-teal-700">
              {code}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Show this at the desk, or check in with the QR code on your booking.
            </p>
            <button
              onClick={onDone}
              className="mt-5 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-bold">{session.name}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {formatHour(session.startHour)} – {formatHour(session.endHour)} with{" "}
              {session.instructor} · RM{session.price}
            </p>
            {isFull && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                This class is full. Join the waitlist and we&apos;ll offer you the first place
                that frees up.
              </p>
            )}
            <form onSubmit={submit} className="mt-4 space-y-3">
              <label className="block text-sm font-medium text-slate-700">
                Name
                <input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Phone
                <input required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="012-345 6789" className={inputClass} />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Email (optional)
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-lg border border-slate-300 py-2 text-sm font-medium text-slate-600 hover:border-slate-400"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="flex-1 rounded-lg bg-teal-600 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  {busy
                    ? isFull
                      ? "Joining…"
                      : "Enrolling…"
                    : isFull
                      ? "Join waitlist"
                      : `Enrol · RM${session.price}`}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
