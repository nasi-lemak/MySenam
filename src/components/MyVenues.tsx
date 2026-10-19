"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";

/**
 * The private and members-only venues this customer is on the list of. A
 * private venue is in no public list, so this is how a resident finds it.
 */
export function MyVenues() {
  const t = useT();
  const [venues, setVenues] = useState<{ id: number; name: string; area: string }[]>([]);
  useEffect(() => {
    void fetch("/api/my/venues", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { venues: [] }))
      .then((d: { venues?: { id: number; name: string; area: string }[] }) => setVenues(d.venues ?? []))
      .catch(() => setVenues([]));
  }, []);
  if (venues.length === 0) return null;
  return (
    <section>
      <h2 className="text-lg font-bold">{t("access.yourVenues")}</h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {venues.map((v) => (
          <li key={v.id}>
            <Link
              href={`/venue/${v.id}`}
              className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-teal-400"
            >
              <p className="font-semibold">🔒 {v.name}</p>
              <p className="text-sm text-slate-500">📍 {v.area}</p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
