/**
 * Finding one record in the counter's lists that grow (X1-7): memberships,
 * passes, receipts, gift vouchers and company invoices
 * (docs/features/payments-and-credit.md#finding-a-record). One way for all of
 * them, the booking search's (lib/store.ts `searchBookings`): a code, a name
 * (any part of it) or a phone number however it is typed (`phone_key`), a
 * status of the list's own, and pages of fifty, newest first.
 */

export const PAGE_SIZE = 50;
/** "Lapsing": still running, and ending within this many days. */
export const LAPSING_DAYS = 30;
/** The most pages anybody needs to step through before searching instead. */
const MAX_PAGE = 1000;

export interface ListQuery {
  /** What was typed; empty for everything. */
  q: string;
  /** One of the list's own statuses, or null for all. */
  status: string | null;
  /** From 1. */
  page: number;
}

/** `q`, `status` and `page` from a request's address, or why not. */
export function readListQuery(params: URLSearchParams, statuses: readonly string[]): ListQuery | { error: string } {
  const q = (params.get("q") ?? "").trim().slice(0, 100);
  const raw = params.get("status");
  const status = raw === null || raw === "" || raw === "all" ? null : raw;
  if (status !== null && !statuses.includes(status)) return { error: `status must be one of ${statuses.join(", ")}.` };
  const page = params.get("page") === null ? 1 : Number(params.get("page"));
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) return { error: "page is a whole number from 1." };
  return { q, status, page };
}

/**
 * The SQL that finds `q` in a list: any of the codes or names containing it,
 * or a phone column holding the same number (seven digits or more, however
 * typed). Empty `q`: everything (`TRUE`).
 */
export function textMatch(q: string, cols: { codes?: string[]; names?: string[]; phones?: string[] }): { sql: string; params: unknown[] } {
  if (q === "") return { sql: "TRUE", params: [] };
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const digits = q.replace(/\D/g, "");
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const c of [...(cols.codes ?? []), ...(cols.names ?? [])]) {
    parts.push(`${c} ILIKE ?`);
    params.push(like);
  }
  if (digits.length >= 7)
    for (const c of cols.phones ?? []) {
      parts.push(`phone_key(${c}) = phone_key(?)`);
      params.push(digits);
    }
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "FALSE", params };
}

/** LIMIT and OFFSET for a page: one more than a page, so `more` can be told. */
export function pageSql(page: number): string {
  return `LIMIT ${PAGE_SIZE + 1} OFFSET ${(page - 1) * PAGE_SIZE}`;
}

export interface Page<T> {
  items: T[];
  page: number;
  /** Whether there is a next page. */
  more: boolean;
}

/** A page from rows read with `pageSql`. */
export function paged<T>(rows: T[], page: number): Page<T> {
  return { items: rows.slice(0, PAGE_SIZE), page, more: rows.length > PAGE_SIZE };
}
