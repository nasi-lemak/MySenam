"use client";

import { useCallback } from "react";
import { sportLabel, type Phrase } from "@/lib/i18n";
import { useT } from "@/components/Language";
import { ApprovalReview, type Say } from "@/components/ApprovalReview";
import { explainApproval } from "@/components/ApprovalForm";

/**
 * At a coach's own link: applications to be approved for the activities the
 * venue authorised them to review (lib/approvals.ts). Shown only when there
 * are some; nothing else of the venue's.
 */
export default function CoachApprovals({ token }: { token: string }) {
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
      listUrl={`/api/coach/${token}/approvals`}
      decideUrl={`/api/coach/${token}/approvals`}
      decideBody={(id, action, reason) => ({ id, action, reason })}
      documentUrl={(id) => `/api/coach/${token}/approvals/document?id=${id}`}
    />
  );
}
