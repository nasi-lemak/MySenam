import Link from "next/link";
import { listVenues } from "@/lib/store";
import { Sport, SPORT_ICONS, SPORT_LABELS, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const venues = listVenues();

  return (
    <div className="space-y-10">
      <section className="rounded-2xl bg-gradient-to-br from-teal-600 to-emerald-500 px-6 py-12 text-white shadow-lg">
        <h1 className="text-3xl font-bold sm:text-4xl">Book a court in seconds.</h1>
        <p className="mt-3 max-w-xl text-teal-50">
          Badminton, tennis, pickleball and futsal — see live availability, pick your slots and
          get a booking code instantly. No calls, no waiting. Mudah je!
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {SPORTS.map((sport) => (
            <span
              key={sport}
              className="rounded-full bg-white/15 px-4 py-1.5 text-sm font-medium backdrop-blur"
            >
              {SPORT_ICONS[sport]} {SPORT_LABELS[sport]}
            </span>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-bold">Venues</h2>
        <p className="mt-1 text-slate-600">Choose a venue to see live court availability.</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {venues.map((venue) => {
            const sportsHere = [...new Set(venue.courts.map((c) => c.sport))] as Sport[];
            const minRate = Math.min(...venue.courts.map((c) => c.offPeakRate));
            return (
              <Link
                key={venue.id}
                href={`/venue/${venue.id}`}
                className="group flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-teal-500 hover:shadow-md"
              >
                <div className="text-lg font-semibold group-hover:text-teal-700">{venue.name}</div>
                <div className="mt-1 text-sm text-slate-500">📍 {venue.area}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {sportsHere.map((sport) => (
                    <span
                      key={sport}
                      className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-700"
                    >
                      {SPORT_ICONS[sport]} {SPORT_LABELS[sport]}
                    </span>
                  ))}
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-sm">
                  <span className="text-slate-500">
                    {venue.courts.length} court{venue.courts.length > 1 ? "s" : ""}
                  </span>
                  <span className="font-semibold text-teal-700">from RM{minRate}/hr</span>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="grid gap-4 rounded-xl border border-slate-200 bg-white p-6 sm:grid-cols-3">
        {[
          ["1. Pick a slot", "Choose venue, date and court — availability is live."],
          ["2. Confirm", "Enter your name and phone. Pay at the counter when you arrive."],
          ["3. Play", "You get a booking code instantly. Show it at the front desk."],
        ].map(([title, body]) => (
          <div key={title}>
            <div className="font-semibold text-teal-700">{title}</div>
            <p className="mt-1 text-sm text-slate-600">{body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
