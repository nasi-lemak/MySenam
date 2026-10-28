"use client";

import { useState } from "react";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";

/** What a list is asked for: the words typed, a status, a page (lib/list-search.ts). */
export interface ListQuery {
  q: string;
  status: string;
  page: number;
}

export const FIRST_PAGE: ListQuery = { q: "", status: "", page: 1 };

/** The query as an address's parameters, starting with `&`. */
export function listParams(query: ListQuery): string {
  return `${query.q ? `&q=${encodeURIComponent(query.q)}` : ""}${query.status ? `&status=${query.status}` : ""}${query.page > 1 ? `&page=${query.page}` : ""}`;
}

/**
 * Search, a status and pages for one of the counter's lists that grow
 * (X1-7): memberships, passes, receipts, vouchers, invoices. Searching or
 * choosing a status goes back to the first page.
 */
export function ListFilter({
  query,
  onChange,
  statuses,
  more,
  placeholder,
}: {
  query: ListQuery;
  onChange: (q: ListQuery) => void;
  /** The list's own statuses, each with its words. */
  statuses: { value: string; label: StaffPhrase }[];
  /** Whether there is a next page. */
  more: boolean;
  placeholder?: StaffPhrase;
}) {
  const t = useStaffT();
  const [typed, setTyped] = useState(query.q);
  const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onChange({ ...query, q: typed.trim(), page: 1 });
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          type="search"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={t(placeholder ?? "p8b.list.search")}
          aria-label={t("p8b.list.searchLabel")}
          className={`w-56 ${input}`}
        />
        <button type="submit" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-teal-500">
          {t("p8b.list.find")}
        </button>
      </form>
      <select value={query.status} onChange={(e) => onChange({ ...query, status: e.target.value, page: 1 })} aria-label={t("p8b.list.status")} className={input}>
        <option value="">{t("p8b.list.all")}</option>
        {statuses.map((s) => (
          <option key={s.value} value={s.value}>
            {t(s.label)}
          </option>
        ))}
      </select>
      {(query.page > 1 || more) && (
        <span className="ml-auto flex items-center gap-1 text-xs text-slate-600">
          <button
            type="button"
            disabled={query.page <= 1}
            onClick={() => onChange({ ...query, page: query.page - 1 })}
            className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-40"
          >
            {t("p8b.list.newer")}
          </button>
          <span>{t("p8b.list.page", { n: query.page })}</span>
          <button
            type="button"
            disabled={!more}
            onClick={() => onChange({ ...query, page: query.page + 1 })}
            className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-40"
          >
            {t("p8b.list.older")}
          </button>
        </span>
      )}
    </div>
  );
}
