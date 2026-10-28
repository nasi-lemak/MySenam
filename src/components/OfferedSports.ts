"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { Sport } from "@/lib/types";

/**
 * The sports somebody here offers (`/api/sports`), for a page's sport chips:
 * nobody is offered squash where nobody has a squash court. Empty until it
 * has been asked, and on a failure, so a page shows only its "all" choice.
 */
export function useOfferedSports(): Sport[] {
  const [sports, setSports] = useState<Sport[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/api/sports")
      .then((res) => (res.ok ? readJson(res) : { sports: [] }))
      .then((data: { sports?: Sport[] }) => {
        if (live) setSports(data.sports ?? []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return sports;
}
