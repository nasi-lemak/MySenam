"use client";

import { useCallback } from "react";
import { sportLabel, type Phrase } from "@/lib/i18n";
import { useT } from "@/components/Language";
import { ApprovalReview, type Say } from "@/components/ApprovalReview";
import { explainApproval } from "@/components/ApprovalForm";

/**
 * A coach's review, signed in to their own account: applications to be
 * approved for the activities each venue that linked this account to its
 * coach record named them for (lib/approvals.ts; ADR 0020). Shown only when
 * there are some; nothing else of the venue's.
 */
export default function CoachApprovals() {
  const t = useT();
  const say: Say = useCallback((key, vars) => t(key as Phrase, vars), [t]);
  const explain = useCallback((body: unknown) => explainApproval(t, body as { error?: string; code?: string }), [t]);
  const activityLabel = useCallback((sport: string) => sportLabel(t, sport), [t]);
  return (
    <ApprovalReview
      say={say}
      locale={t.locale}
      activityLabel={activityLabel}
      explain={explain}
      title={t("apr.coachTitle")}
      hideWhenEmpty
      listUrl="/api/my/reviews"
      decideUrl="/api/my/reviews"
      decideBody={(id, action, reason) => ({ id, action, reason })}
      documentUrl={(id) => `/api/my/reviews/document?id=${id}`}
    />
  );
}
