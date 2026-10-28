"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { StaffActionName } from "@/lib/roles";
import { useStaffT } from "./StaffLanguage";

/**
 * What the member of staff signed in may do from the dashboard (audit R8
 * X1-5), as `/api/admin/auth/me` answers it from lib/roles.ts (`staffMay`):
 * front desk is shown what only a manager changes read-only, with one line
 * saying so and no buttons, rather than shown a form and then refused.
 * The server refuses the desk regardless (`MANAGER_ONLY`).
 *
 * Given once, by the dashboard page. A screen shown on its own (a component
 * test) with no answers given offers everything, as a manager's does.
 */
const MayContext = createContext<Partial<Record<StaffActionName, boolean>> | null>(null);

export function StaffMayProvider({ may, children }: { may: Partial<Record<StaffActionName, boolean>> | null | undefined; children: ReactNode }) {
  return <MayContext.Provider value={may ?? null}>{children}</MayContext.Provider>;
}

/** `may("courts")`: whether this account may do that. */
export function useStaffMay(): (action: StaffActionName) => boolean {
  const may = useContext(MayContext);
  return useCallback((action: StaffActionName) => may === null || may[action] !== false, [may]);
}

/**
 * Children as they are where `may` is allowed; otherwise read-only: inside a
 * disabled fieldset (every field and button in it disabled), its buttons
 * hidden, under one line saying a manager changes this (`note`, unless a
 * line above already says so).
 */
export function ManagerOnly({ may, note = true, className = "", children }: { may: StaffActionName; note?: boolean; className?: string; children: ReactNode }) {
  const t = useStaffT();
  const allowed = useStaffMay()(may);
  if (allowed) return <>{children}</>;
  return (
    <div data-manager-only={may} className="w-full">
      {note && <p className="mb-1 text-xs text-slate-500">{t("r9a.managerChanges")}</p>}
      <fieldset disabled className={`m-0 min-w-0 border-0 p-0 [&_button]:hidden ${className}`}>
        {children}
      </fieldset>
    </div>
  );
}

/** One line saying a manager changes what follows, for front desk only. */
export function ManagerChangesNote({ may }: { may: StaffActionName }) {
  const t = useStaffT();
  if (useStaffMay()(may)) return null;
  return <p className="text-xs text-slate-500">{t("r9a.managerChanges")}</p>;
}
