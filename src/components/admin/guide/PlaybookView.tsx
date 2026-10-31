"use client";

import { useEffect, useState } from "react";
import { readJson } from "@/lib/read-response";
import type { Playbook, GuideLink } from "@/lib/guide/playbook/types";
import type { DashboardTab, GuideRole, GuideView } from "@/lib/guide/shell";
import { useStaffT } from "../StaffLanguage";
import { PlaybookDocument } from "./PlaybookDocument";

/** What `GET /api/admin/guide/playbook` answers. */
interface PlaybookAnswer {
  venueId: number;
  role: GuideRole;
  ownRole: GuideRole;
  roles: GuideRole[];
  playbook: Playbook;
}

/**
 * The guide's "How to run it" view (docs/features/venue-guide.md, "The
 * operating playbook"): reads the venue's playbook for the reader's own role,
 * or, for a manager preparing training, for the front desk's or a coach's
 * (`as`), afresh each time the venue or the role changes, and draws it as a
 * document. A link in it opens the dashboard screen it names; the server only
 * put there the links this role may use.
 */
export function PlaybookView({ venueId, onGo, onView }: { venueId: number; onGo: (tab: DashboardTab) => void; onView?: (view: GuideView) => void }) {
  const t = useStaffT();
  const [as, setAs] = useState<GuideRole | null>(null);
  const [data, setData] = useState<PlaybookAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    fetch(`/api/admin/guide/playbook?venueId=${venueId}${as ? `&as=${as}` : ""}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await readJson(res);
        if (!res.ok) throw new Error(t.err(body, t("gd.failed")));
        if (current) setData(body);
      })
      .catch((err) => current && setError(err instanceof Error ? err.message : t("gd.failed")));
    return () => {
      current = false;
    };
  }, [venueId, as, t]);

  const go = (link: GuideLink) => {
    if (link.tab === "guide" && link.view && onView) onView(link.view as GuideView);
    else onGo(link.tab);
  };

  if (error)
    return (
      <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </p>
    );
  if (!data) return <p className="text-sm text-slate-500">{t("gd.loading")}</p>;
  return (
    <section aria-labelledby="guide-playbook-heading" className="space-y-3">
      <h3 id="guide-playbook-heading" className="font-semibold print:hidden">
        {t("gp.heading")}
      </h3>
      <PlaybookDocument playbook={data.playbook} ownRole={data.ownRole} roles={data.roles} onViewAs={setAs} onGo={go} />
    </section>
  );
}
