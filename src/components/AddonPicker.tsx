"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { T } from "@/lib/i18n";
import { money } from "@/lib/region";

/** One extra as the public list gives it. */
export interface OfferedAddon {
  id: number;
  name: string;
  kind: "rental" | "sale";
  price: number;
  /** Rentals left for these hours; null when there is no limit. */
  left: number | null;
}

export type Picked = Record<number, number>;

/** What the picked extras come to. */
export function pickedTotal(list: OfferedAddon[], picked: Picked): number {
  return Math.round(list.reduce((s, a) => s + (picked[a.id] ?? 0) * a.price, 0) * 100) / 100;
}

/** `[{ addonId, quantity }]` for the request. */
export function pickedList(picked: Picked) {
  return Object.entries(picked)
    .filter(([, q]) => q > 0)
    .map(([id, q]) => ({ addonId: Number(id), quantity: q }));
}

/**
 * Extras a venue offers with this booking, folded away until asked for and
 * never chosen for the customer. Nothing shows when the venue offers none.
 */
export default function AddonPicker({
  t,
  query,
  picked,
  onChange,
  onList,
}: {
  t: T;
  /** The query string for /api/addons, e.g. `courtId=3&date=…&hours=18,19`. */
  query: string;
  picked: Picked;
  onChange: (next: Picked) => void;
  onList?: (list: OfferedAddon[]) => void;
}) {
  const [list, setList] = useState<OfferedAddon[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/addons?${query}`, { cache: "no-store" })
      .then((res) => (res.ok ? readJson(res) : { addons: [] }))
      .then((data) => {
        if (!live) return;
        const next = (data.addons ?? []) as OfferedAddon[];
        setList(next);
        onList?.(next);
        // Keep what is still offered, no more than are left.
        const kept: Picked = {};
        for (const a of next) {
          const q = picked[a.id] ?? 0;
          if (q > 0) kept[a.id] = a.left === null ? q : Math.min(q, a.left);
        }
        if (JSON.stringify(pickedList(kept)) !== JSON.stringify(pickedList(picked))) onChange(kept);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // Fetched again only when what is being booked changes. What is picked is
    // read as it stands then; following it too would fetch again on every pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  if (list.length === 0) return null;
  const count = Object.values(picked).reduce((s, q) => s + q, 0);
  const total = pickedTotal(list, picked);

  return (
    <div className="mt-2 text-xs text-slate-600">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="font-medium text-teal-700 underline"
      >
        {count > 0 ? t("addons.chosen", { n: count, amount: total }) : t.plural("addons.offer", list.length)}
      </button>
      {open && (
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {list.map((a) => {
            const q = picked[a.id] ?? 0;
            const most = Math.min(20, a.left ?? 20);
            const set = (n: number) => onChange({ ...picked, [a.id]: Math.max(0, Math.min(most, n)) });
            return (
              <li key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-2 py-1.5">
                <span className="min-w-0">
                  <span className="font-medium text-slate-800">{a.name}</span>{" "}
                  <span className="text-slate-500">
                    {money(a.price)}
                    {a.kind === "rental" ? ` ${t("addons.toHire")}` : ""}
                    {a.left !== null && a.left <= 5 && ` · ${a.left === 0 ? t("addons.noneLeft") : t("addons.left", { n: a.left })}`}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => set(q - 1)}
                    disabled={q === 0}
                    aria-label={t("addons.less", { name: a.name })}
                    className="h-7 w-7 rounded border border-slate-300 font-semibold disabled:opacity-30"
                  >
                    −
                  </button>
                  <span className="w-5 text-center font-semibold tabular-nums text-slate-900" aria-live="polite">
                    {q}
                  </span>
                  <button
                    type="button"
                    onClick={() => set(q + 1)}
                    disabled={q >= most}
                    aria-label={t("addons.more", { name: a.name })}
                    className="h-7 w-7 rounded border border-slate-300 font-semibold disabled:opacity-30"
                  >
                    +
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
