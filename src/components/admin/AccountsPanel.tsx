"use client";

import { readJson } from "@/lib/read-response";
import { ManagerOnly, useStaffMay } from "./StaffMay";
import { useCallback, useEffect, useState } from "react";
import type { Account, AccountInvoice } from "@/lib/accounts";
import { COUNTER_METHODS, type CounterMethod } from "@/lib/types";
import type { ManagedVenue } from "./shared";
import { money } from "@/lib/region";
import { LOCALE_NAMES, type Locale } from "@/lib/i18n";
import { todayLocal } from "./shared";
import { useStaffT } from "./StaffLanguage";
import { FIRST_PAGE, ListFilter, listParams, type ListQuery } from "./ListFilter";

const BLANK = { name: "", contact: "", email: "", address: "", taxNo: "", termsDays: "30", creditLimit: "", locale: "" };

/**
 * Company and school accounts (lib/accounts.ts): open one, say whose numbers
 * may book on it, and see what it owes. Its bookings are invoiced together at
 * the start of each month; mark an invoice paid when the money comes in.
 */
export function AccountsPanel({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  // Opening, changing and invoicing accounts are a manager's; the desk charges bookings to them and takes payments (lib/roles.ts).
  const may = useStaffMay();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [invoices, setInvoices] = useState<AccountInvoice[]>([]);
  const [languages, setLanguages] = useState<Locale[]>([]);
  const [form, setForm] = useState<typeof BLANK & { id?: number }>(BLANK);
  const [booker, setBooker] = useState<Record<number, { name: string; phone: string }>>({});
  const [paying, setPaying] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Invoices found by number or account, open, overdue or paid, a page at a time (X1-7).
  const [query, setQuery] = useState<ListQuery>(FIRST_PAGE);
  const [more, setMore] = useState(false);

  const load = useCallback(async () => {
    if (!venueId) return;
    const [res, inv] = await Promise.all([
      fetch(`/api/admin/accounts?venueId=${venueId}`, { cache: "no-store" }),
      fetch(`/api/admin/accounts/invoices?venueId=${venueId}${listParams(query)}`, { cache: "no-store" }),
    ]);
    if (!res.ok) return;
    const data = await readJson(res);
    setAccounts(data.accounts);
    setLanguages(data.languages ?? []);
    if (inv.ok) {
      const found = await readJson(inv);
      setInvoices(found.invoices ?? []);
      setMore(found.more === true);
    }
  }, [venueId, query]);

  useEffect(() => {
    load();
  }, [load]);

  async function send(url: string, method: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setError(null);
    setNotice(null);
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await readJson(res);
    if (!res.ok) {
      setError(t.err(data));
      return null;
    }
    await load();
    return data;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const done = await send("/api/admin/accounts", "POST", {
      venueId,
      ...form,
      termsDays: Number(form.termsDays),
      creditLimit: form.creditLimit === "" ? null : Number(form.creditLimit),
    });
    if (done) {
      setNotice(form.id ? t("acc.saved", { name: form.name }) : t("acc.opened", { name: form.name }));
      setForm(BLANK);
    }
  }

  // Last month, as the scheduled invoice would; or this month so far, on a manager's say.
  const thisMonth = todayLocal().slice(0, 7);
  const [y, m] = thisMonth.split("-").map(Number);
  const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;

  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">{t("acc.title")}</h2>
      <p className="mt-1 text-sm text-slate-600">{t("acc.intro")}</p>
      {venues.length > 1 && (
        <select aria-label={t("q8b.l.venue")} value={venueId} onChange={(e) => setVenueId(Number(e.target.value))} className={`mt-3 ${input}`}>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      )}

      {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}

      <ul className="mt-4 space-y-3">
        {accounts.map((a) => (
          <li key={a.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <span className="font-semibold">{a.name}</span>{" "}
                {a.closed && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{t("rg7.acc.closed")}</span>}{" "}
                <span className="text-slate-500">
                  · {a.email} · {t.plural("acc.termsDays", a.termsDays)}
                  {a.creditLimit !== null ? ` · ${t("acc.limit", { amount: money(a.creditLimit) })}` : ""}
                  {languages.length > 1 ? ` · ${t("acc.invoicesIn", { language: LOCALE_NAMES[a.locale] })}` : ""}
                </span>
              </div>
              <div className="text-slate-700">
                {t("acc.uninvoiced")} <strong>{money(a.uninvoiced)}</strong> · {t("acc.owing")} <strong>{money(a.owing)}</strong>
                {a.credit > 0 && (
                  <>
                    {" "}
                    · {t("pw6.acc.credit")} <strong>{money(a.credit)}</strong>{" "}
                    {/* Paid back some other way (a bank transfer): recorded, so it never comes off an invoice (managers). */}
                    {may("accountCredits") && (
                    <button
                      type="button"
                      className="text-xs font-medium text-teal-700 underline"
                      onClick={async () => {
                        const note = window.prompt(t("rg7.acc.settlePrompt", { amount: money(a.credit), name: a.name }), "");
                        if (note === null) return;
                        const done = await send("/api/admin/accounts/credits", "POST", { venueId, accountId: a.id, note });
                        if (done) setNotice(t("rg7.acc.settled", { amount: money(Number(done.amount)), name: a.name }));
                      }}
                    >
                      {t("rg7.acc.settle")}
                    </button>
                    )}
                  </>
                )}
              </div>
            </div>
            {/* A closed account is listed only for its credit: nothing else to do on it. */}
            {!a.closed && (
            <>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {a.bookers.map((b) => (
                <span key={b.phone} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs">
                  {b.name} · {b.phone}
                  {may("accountBookers") && (
                  <button
                    type="button"
                    aria-label={t("acc.takeOff", { name: b.name })}
                    onClick={() =>
                      send(`/api/admin/accounts/bookers?venueId=${venueId}&accountId=${a.id}&phone=${encodeURIComponent(b.phone)}`, "DELETE")
                    }
                    className="text-slate-400 hover:text-red-600"
                  >
                    ×
                  </button>
                  )}
                </span>
              ))}
              {may("accountBookers") && (
              <form
                className="flex flex-wrap items-center gap-1"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const b = booker[a.id] ?? { name: "", phone: "" };
                  if (await send("/api/admin/accounts/bookers", "POST", { venueId, accountId: a.id, ...b }))
                    setBooker({ ...booker, [a.id]: { name: "", phone: "" } });
                }}
              >
                <input
                  placeholder={t("acc.whoMayBook")} aria-label={t("acc.whoMayBook")}
                  value={booker[a.id]?.name ?? ""}
                  onChange={(e) => setBooker({ ...booker, [a.id]: { phone: booker[a.id]?.phone ?? "", name: e.target.value } })}
                  className="w-32 rounded-md border border-slate-300 px-2 py-1 text-xs"
                />
                <input
                  placeholder={t("acc.theirPhone")} aria-label={t("acc.theirPhone")}
                  value={booker[a.id]?.phone ?? ""}
                  onChange={(e) => setBooker({ ...booker, [a.id]: { name: booker[a.id]?.name ?? "", phone: e.target.value } })}
                  className="w-28 rounded-md border border-slate-300 px-2 py-1 text-xs"
                />
                <button className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium hover:border-teal-500">{t("c.add")}</button>
              </form>
              )}
            </div>
            {may("accountInvoices") && (
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              <button
                type="button"
                className="font-medium text-teal-700 underline"
                onClick={async () => {
                  const done = await send("/api/admin/accounts/invoices", "POST", { accountId: a.id, period: lastMonth });
                  if (done) setNotice(t("acc.invoiced", { name: a.name, month: lastMonth }));
                }}
              >
                {t("acc.invoiceNow", { month: lastMonth })}
              </button>
              <button
                type="button"
                className="font-medium text-teal-700 underline"
                onClick={async () => {
                  const done = await send("/api/admin/accounts/invoices", "POST", { accountId: a.id, period: thisMonth });
                  if (done) setNotice(t("acc.invoicedSoFar", { name: a.name, month: thisMonth }));
                }}
              >
                {t("acc.invoiceSoFar")}
              </button>
              <button
                type="button"
                className="text-slate-600 underline"
                onClick={() =>
                  setForm({
                    id: a.id,
                    name: a.name,
                    contact: a.contact ?? "",
                    email: a.email,
                    address: a.address ?? "",
                    taxNo: a.taxNo ?? "",
                    termsDays: String(a.termsDays),
                    creditLimit: a.creditLimit === null ? "" : String(a.creditLimit),
                    locale: a.locale,
                  })
                }
              >
                {t("c.change")}
              </button>
              <button
                type="button"
                className="text-red-600 underline"
                onClick={() => {
                  if (confirm(t("acc.closeConfirm", { name: a.name })))
                    void send(`/api/admin/accounts?venueId=${venueId}&id=${a.id}`, "DELETE");
                }}
              >
                {t("c.close")}
              </button>
            </div>
            )}
            </>
            )}
          </li>
        ))}
      </ul>

      <ManagerOnly may="accounts">
      <form onSubmit={save} className="mt-4 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3">
        <p className="text-sm font-semibold sm:col-span-3">{form.id ? t("acc.changeName", { name: form.name }) : t("acc.open")}</p>
        <input required placeholder={t("acc.org")} aria-label={t("acc.org")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
        <input placeholder={t("acc.contact")} aria-label={t("acc.contact")} value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} className={input} />
        <input required type="email" placeholder={t("acc.email")} aria-label={t("acc.email")} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={input} />
        <input placeholder={t("acc.address")} aria-label={t("acc.address")} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={input} />
        <input placeholder={t("acc.taxNo")} aria-label={t("acc.taxNo")} value={form.taxNo} onChange={(e) => setForm({ ...form, taxNo: e.target.value })} className={input} />
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col text-xs text-slate-500">
            {t("acc.daysToPay")}
            <input type="number" min={0} max={90} value={form.termsDays} onChange={(e) => setForm({ ...form, termsDays: e.target.value })} className={input} />
          </label>
          <label className="flex flex-1 flex-col text-xs text-slate-500">
            {t("acc.limitField")}
            <input type="number" min={1} step="0.01" value={form.creditLimit} onChange={(e) => setForm({ ...form, creditLimit: e.target.value })} className={input} />
          </label>
          {languages.length > 1 && (
            <label className="flex flex-1 flex-col text-xs text-slate-500">
              {t("acc.invoicesInField")}
              <select value={form.locale || languages[0]} onChange={(e) => setForm({ ...form, locale: e.target.value })} className={input}>
                {languages.map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_NAMES[l]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="flex gap-2 sm:col-span-3">
          <button className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">{form.id ? t("c.save") : t("acc.openButton")}</button>
          {form.id && (
            <button type="button" onClick={() => setForm(BLANK)} className="rounded-md border border-slate-300 px-3 py-2 text-sm">
              {t("c.neverMind")}
            </button>
          )}
        </div>
      </form>
      </ManagerOnly>

      {(invoices.length > 0 || query !== FIRST_PAGE) && (
        <ListFilter
          query={query}
          onChange={setQuery}
          more={more}
          placeholder="p8b.list.searchInvoices"
          statuses={[
            { value: "open", label: "p8b.list.open" },
            { value: "overdue", label: "p8b.list.overdue" },
            { value: "paid", label: "p8b.list.paid" },
          ]}
        />
      )}
      {invoices.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-2 font-medium">{t("acc.colInvoice")}</th>
              <th className="py-2 pr-2 font-medium">{t("acc.colAccount")}</th>
              <th className="py-2 pr-2 font-medium">{t("acc.colDue")}</th>
              <th className="py-2 pr-2 text-right font-medium">{t("c.total")}</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} className="border-b border-slate-100">
                <td className="py-2 pr-2">
                  <a href={`/account-invoice/${i.token}`} target="_blank" rel="noreferrer" className="font-mono text-teal-700 underline">
                    {i.number}
                  </a>
                </td>
                <td className="py-2 pr-2">{i.accountName}</td>
                <td className={`py-2 pr-2 ${!i.paidOn && i.dueOn < todayLocal() ? "font-semibold text-red-600" : ""}`}>{i.dueOn}</td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {money(i.total)}
                  {i.credited > 0 && <span className="block text-xs text-slate-500">{t("pw6.acc.credited", { amount: money(i.credited), due: money(i.due) })}</span>}
                </td>
                <td className="py-2 text-right text-xs">
                  {i.paidOn ? (
                    <span className="text-emerald-700">
                      {t("acc.paidOn", { date: i.paidOn })}
                      {i.paidVia ? `, ${t(`c.via.${i.paidVia}`)}` : ""}
                    </span>
                  ) : paying === i.id ? (
                    <span className="inline-flex flex-wrap gap-1">
                      {COUNTER_METHODS.map((via: CounterMethod) => (
                        <button
                          key={via}
                          type="button"
                          onClick={async () => {
                            if (await send(`/api/admin/accounts/invoices/${i.id}`, "POST", { via })) setPaying(null);
                          }}
                          className="rounded border border-slate-300 px-2 py-0.5 hover:border-teal-500"
                        >
                          {t(`c.via.${via}`)}
                        </button>
                      ))}
                    </span>
                  ) : (
                    <span className="inline-flex gap-2">
                      <button type="button" onClick={() => setPaying(i.id)} className="font-medium text-teal-700 underline">
                        {t("acc.markPaid")}
                      </button>
                      {may("invoiceWithdraw") && (
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(t("acc.withdrawConfirm", { number: i.number })))
                            void send(`/api/admin/accounts/invoices/${i.id}`, "DELETE");
                        }}
                        className="text-slate-500 underline"
                      >
                        {t("acc.withdraw")}
                      </button>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
