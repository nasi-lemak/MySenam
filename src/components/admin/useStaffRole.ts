"use client";

import { useEffect, useState } from "react";

/** Who is signed in, asked once per page however many screens ask. */
let asked: Promise<{ id: number; role: "manager" | "desk" } | null> | null = null;

function me() {
  asked ??= fetch("/api/admin/auth/me", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d?.admin ? { id: d.admin.id as number, role: d.admin.role === "desk" ? ("desk" as const) : ("manager" as const) } : null))
    .catch(() => null);
  return asked;
}

/** Ask again next time (signing in as somebody else; tests). */
export function forgetStaffRole(): void {
  asked = null;
}

/**
 * Whether the member of staff signed in is front desk or a manager, so a
 * screen shows a manager's controls only to a manager (the server refuses
 * the desk regardless, lib/roles.ts). Null until known.
 */
export function useStaffRole(): { id: number; role: "manager" | "desk" } | null {
  const [who, setWho] = useState<{ id: number; role: "manager" | "desk" } | null>(null);
  useEffect(() => {
    let live = true;
    void me().then((w) => {
      if (live) setWho(w);
    });
    return () => {
      live = false;
    };
  }, []);
  return who;
}
