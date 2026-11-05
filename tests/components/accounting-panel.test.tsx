// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AccountingPanel } from "../../src/components/admin/AccountingPanel";

/**
 * Reports, Accounting (ADR 0041): what a manager sees before connecting (the notice and the acknowledgement), when it is
 * connected (the queue, what is held for mapping, what failed and why), the mapping, the start day with its preview, and the
 * check against Xero. The routes are answered by a stand-in here; their own behaviour is in tests/accounting-push-routes.test.ts.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const counts = { queued: 0, sending: 0, sent: 12, failed: 1, held: 2, skipped: 3, retrying: 0 };
const chart = {
  accounts: [
    { code: "200", name: "Court hire income", class: "REVENUE", acceptsPayments: false },
    { code: "800", name: "Customer credit held", class: "LIABILITY", acceptsPayments: true },
    { code: "090", name: "Bank", class: "ASSET", acceptsPayments: true },
  ],
  taxRates: [
    { type: "NONE", name: "No tax", rate: 0 },
    { type: "SV6", name: "Service tax 6%", rate: 6 },
    { type: "SV8", name: "Service tax 8%", rate: 8 },
  ],
  fetchedAt: "2026-11-05T01:00:00.000Z",
};
const view = (over: Record<string, unknown> = {}, connection: Record<string, unknown> = {}) => ({
  connection: {
    available: { approved: true, configured: true },
    noticeVersion: 1,
    status: "connected",
    organisation: "Demo Company (MY)",
    connectedAt: "2026-11-01T01:00:00.000Z",
    connectedBy: "Musa Manager",
    acknowledgedAt: "2026-11-01T01:00:00.000Z",
    acknowledgedBy: "Musa Manager",
    startDate: "2026-11-01",
    lastOkAt: "2026-11-05T01:00:00.000Z",
    failingSince: null,
    pausedUntil: null,
    ...connection,
  },
  mapping: { account: { "Court hire": { code: "200", name: "Court hire income" } }, tax: {}, payment: {} },
  chart,
  keys: { account: ["Court hire", "Stored credit", "Gift vouchers"], owed: ["Stored credit", "Gift vouchers"], payment: ["cash", "none"], tax: ["none", "rate:6"] },
  queue: {
    counts,
    held: [{ id: 5, number: "R-000005", category: "Passes", day: "2026-11-04", grossCents: 10000, kind: "invoice", needs: ["account:Passes", "tax:rate:6", "payment:cash"] }],
    failed: [{ id: 9, number: "R-000009", category: "Court hire", day: "2026-11-03", grossCents: 2120, kind: "invoice", code: "rejected", detail: "Account code '200' is not a valid code.", attempts: 1 }],
    skipped: { before_connection: 2, nothing_to_record: 1 },
  },
  ...over,
});

let calls: { url: string; method: string; body: Record<string, unknown> | null }[];
function answer(routes: Record<string, (body: Record<string, unknown> | null, url: string) => unknown>, first: unknown) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      const reply = method === "GET" && !url.includes("reconcile") ? first : (routes[String(body?.action ?? (url.includes("reconcile") ? "reconcile" : ""))]?.(body, url) ?? {});
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    })
  );
}

const panel = () => render(<AccountingPanel venueId={3} from="2026-11-01" to="2026-11-05" />);

describe("before it is connected", () => {
  it("says the install has not allowed it, offering no way to connect, and points to the export that still works", async () => {
    answer({}, view({}, { status: "not_connected", available: { approved: false, configured: true }, organisation: null }));
    panel();
    expect(await screen.findByText(/not switched on for this site/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Xero" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("says when the install has not registered its Xero app", async () => {
    answer({}, view({}, { status: "not_connected", available: { approved: true, configured: false }, organisation: null }));
    panel();
    expect(await screen.findByText(/has not registered its Xero app/)).toBeTruthy();
  });

  it("shows what is sent and where Xero keeps it, and connects only once the venue has agreed", async () => {
    answer({ connect: () => ({ url: "https://login.xero.com/identity/connect/authorize?state=abc" }) }, view({}, { status: "not_connected", organisation: null, acknowledgedAt: null }));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    panel();
    expect(await screen.findByText("What is sent to Xero")).toBeTruthy();
    expect(screen.getByText(/customer's name and email address/)).toBeTruthy();
    expect(screen.getByText(/Never sent: phone numbers, a child's name/)).toBeTruthy();
    expect(screen.getByText(/outside Malaysia/)).toBeTruthy();
    const connect = screen.getByRole("button", { name: "Connect Xero" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /venue agrees to send this to Xero/ }));
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://login.xero.com/identity/connect/authorize?state=abc"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ venueId: 3, action: "connect", acknowledged: true, noticeVersion: 1 });
  });
});

describe("when it is connected", () => {
  it("shows the organisation, who agreed and when, the counts, what is held and why, and what failed in words", async () => {
    answer({}, view());
    panel();
    expect(await screen.findByText("Connected to Demo Company (MY)")).toBeTruthy();
    expect(screen.getByText(/Sending sales from 2026-11-01/)).toBeTruthy();
    expect(screen.getByText(/The venue agreed .* \(Musa Manager\), wording version 1/)).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    // Held, saying what each needs in words.
    const held = screen.getByText("R-000005").closest("li")!;
    expect(within(held).getByText(/Needs an income account for Pass, a tax type for 6% tax, an account for Cash/)).toBeTruthy();
    // Failed, with Xero's words and a way to send it again.
    const failed = screen.getByText("R-000009").closest("li")!;
    expect(within(failed).getByText(/Xero refused it: Account code '200' is not a valid code\./)).toBeTruthy();
    expect(screen.getByText("2 credit notes for sales from before the start day, which Xero does not have")).toBeTruthy();
  });

  it("says plainly when a connection needs renewing, and that nothing is being sent", async () => {
    answer({}, view({}, { status: "needs_reconnect", failingSince: "2026-11-04T01:00:00.000Z" }));
    panel();
    expect(await screen.findByText(/asked for the connection to be renewed/)).toBeTruthy();
    expect(screen.getByText(/Nothing has got through since/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Xero" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("sends a failed sale again, and all of them", async () => {
    answer({ retry: () => ({ count: 1, queue: view().queue }) }, view());
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Send again" }));
    await waitFor(() => expect(calls.some((c) => c.body?.action === "retry" && c.body.id === 9)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Send the failed ones again" }));
    await waitFor(() => expect(calls.some((c) => c.body?.action === "retry" && c.body.id === undefined)).toBe(true));
  });

  it("offers each choice in its own list: income accounts for income, liabilities for money owed, the rate's own tax types, and saves only what was changed", async () => {
    answer({ mapping: () => ({ mapping: {}, queue: view().queue }) }, view());
    panel();
    const court = (await screen.findByRole("combobox", { name: "Court hire" })) as HTMLSelectElement;
    expect(court.value).toBe("200");
    expect([...court.options].map((o) => o.value)).toEqual(["", "200"]);
    const owed = screen.getByRole("combobox", { name: "Stored credit" }) as HTMLSelectElement;
    expect([...owed.options].map((o) => o.value)).toEqual(["", "800"]);
    const six = screen.getByRole("combobox", { name: "6% tax" }) as HTMLSelectElement;
    expect([...six.options].map((o) => o.value)).toEqual(["", "SV6"]);
    expect([...(screen.getByRole("combobox", { name: "No tax" }) as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "NONE"]);
    const cash = screen.getByRole("combobox", { name: "Cash" }) as HTMLSelectElement;
    expect([...cash.options].map((o) => o.value)).toEqual(["", "800", "090"]);
    const save = screen.getByRole("button", { name: "Save mapping" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(six, { target: { value: "SV6" } });
    fireEvent.change(cash, { target: { value: "090" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.body?.action === "mapping")).toBe(true));
    expect(calls.find((c) => c.body?.action === "mapping")?.body).toEqual({ venueId: 3, action: "mapping", account: {}, tax: { "rate:6": "SV6" }, payment: { cash: "090" } });
  });

  it("previews earlier sales and sends them only with the preview's count and total confirmed", async () => {
    answer({ preview_start: () => ({ preview: { from: "2026-10-20", count: 4, totalCents: 123450 } }), start: () => ({ added: 4, queue: view().queue, connection: view().connection }) }, view());
    panel();
    const input = (await screen.findByLabelText("Send everything from")) as HTMLInputElement;
    const check = screen.getByRole("button", { name: "Check" }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "2026-10-20" } });
    fireEvent.click(check);
    expect(await screen.findByText("4 documents, RM1234.50 (sales less credit notes)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send these" }));
    await waitFor(() => expect(calls.some((c) => c.body?.action === "start")).toBe(true));
    expect(calls.find((c) => c.body?.action === "start")?.body).toEqual({ venueId: 3, action: "start", from: "2026-10-20", count: 4, totalCents: 123450 });
    expect(await screen.findByText("4 queued.")).toBeTruthy();
  });

  it("says plainly whether the venue's totals and Xero's match, and by how much they do not", async () => {
    const report = (differs: boolean) => ({
      reconciliation: {
        from: "2026-11-01",
        to: "2026-11-05",
        ledger: { count: 5, grossCents: 10000, taxCents: 600 },
        sent: { count: differs ? 4 : 5, grossCents: differs ? 7880 : 10000, taxCents: differs ? 480 : 600 },
        differs,
        days: differs ? [{ day: "2026-11-04", ledgerGrossCents: 4000, sentGrossCents: 1880 }] : [],
        waiting: { queued: 0, held: differs ? 1 : 0, failed: 0, skipped: {} },
      },
    });
    answer({ reconcile: () => report(true) }, view());
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Check 2026-11-01 to 2026-11-05" }));
    expect(await screen.findByText(/They do not match\. The ledger has 5 documents, RM100\.00 \(tax RM6\.00\); Xero has 4, RM78\.80 \(tax RM4\.80\)\. The difference is RM21\.20\./)).toBeTruthy();
    expect(screen.getByText(/Not in Xero yet: 0 waiting, 1 held for mapping, 0 failed\./)).toBeTruthy();
    expect(screen.getByText("2026-11-04: ledger RM40.00, Xero RM18.80")).toBeTruthy();
    cleanup();
    answer({ reconcile: () => report(false) }, view());
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Check 2026-11-01 to 2026-11-05" }));
    expect(await screen.findByText("They match: 5 documents, RM100.00, tax RM6.00.")).toBeTruthy();
  });

  it("disconnects only after asking, and says when Xero could not be reached to take the access back", async () => {
    answer({ disconnect: () => ({ revoked: false, connection: view().connection }) }, view());
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    panel();
    const button = await screen.findByRole("button", { name: "Disconnect" });
    fireEvent.click(button);
    expect(calls.some((c) => c.body?.action === "disconnect")).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(calls.some((c) => c.body?.action === "disconnect")).toBe(true));
    expect(await screen.findByText(/Xero could not be reached to remove the access/)).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("shows a refusal from the server in the staff language, not as a code", async () => {
    answer({}, view());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(JSON.stringify({ error: "Xero could not be reached. Try again in a few minutes." }), { status: 409 })
          : new Response(JSON.stringify(view()), { status: 200 })
      )
    );
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Read accounts and tax rates from Xero" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Xero could not be reached");
  });
});

beforeEach(() => {
  vi.unstubAllGlobals();
});
