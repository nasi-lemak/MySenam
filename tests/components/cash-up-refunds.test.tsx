// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { CashUpSheet } from "../../src/components/admin/CashUpSheet";
import { staffTranslator } from "../../src/lib/staff-i18n";
import type { CashUp } from "../../src/lib/cash-up";

/**
 * The cash-up's refunds block (ADR 0075): what was handed back on the day by the method used, what is still owed back, and the till's
 * expected amount with the refunds column. The screen and the printout draw the same sheet.
 */

const NO = { byMethod: [], totals: { taken: 0, givenBack: 0, net: 0 }, entries: [] };
const sheet = (over: Partial<CashUp>): CashUp =>
  ({
    venueId: 1,
    date: "2026-03-10",
    staffId: null,
    ...NO,
    byMethod: [{ method: "cash", taken: 0, givenBack: 20, net: -20, count: 1, money: true }],
    totals: { taken: 0, givenBack: 20, net: -20 },
    entries: [{ at: "2026-03-10T04:00:00.000Z", number: "CN-000001", type: "Credit note", customer: "Aina", description: "", category: "Court hire", method: "cash", gross: -20, staffName: null }],
    test: NO,
    staff: [],
    deposits: { byMethod: [], entries: [], held: [], heldTotal: 0 },
    expected: [{ method: "cash", journalNet: -20, refundNotes: 20, handedBack: 0, depositsNet: 0, expected: 0 }],
    refunds: {
      handed: [],
      handedByMethod: [],
      owed: [{ kind: "booking", reference: "MS-AAAAAA", amount: 20, method: "cash", cause: "customer_cancelled", customerCancelled: true, creditNote: "CN-000001", since: "2026-03-10T04:00:00.000Z" }],
      owedByMethod: [{ method: "cash", amount: 20, count: 1 }],
      owedTotal: 20,
    },
    counts: [],
    ...over,
  }) as CashUp;

describe("the cash-up sheet's refunds", () => {
  it("shows a refund owed as owed, with the credit note as the record and the till not lowered", () => {
    render(<CashUpSheet data={sheet({})} t={staffTranslator("en")} time={(at) => at.slice(11, 16)} />);
    const block = screen.getByTestId("cash-up-refunds");
    expect(block.textContent).toContain("A credit note records the cancellation; it is not cash leaving a till");
    expect(block.textContent).toContain("Nothing was handed back on this day.");
    expect(block.textContent).toContain("MS-AAAAAA");
    expect(block.textContent).toContain("the customer cancelled it");
    expect(block.textContent).toContain("Still owed back in all: RM20");
    // The expected till for the day is RM0, not minus RM20.
    expect(screen.getByRole("region", { name: "What each till should hold" }).textContent).toContain("RM0");
  });

  it("shows a refund handed over on its day, by the method used and the one the customer paid with", () => {
    const data = sheet({
      byMethod: [],
      totals: { taken: 0, givenBack: 0, net: 0 },
      entries: [],
      expected: [{ method: "cash", journalNet: 0, refundNotes: 0, handedBack: 20, depositsNet: 0, expected: -20 }],
      refunds: {
        handed: [{ at: "2026-03-11T04:00:00.000Z", kind: "booking", reference: "MS-AAAAAA", creditNote: "CN-000001", amount: 20, method: "cash", paidWith: "qr", countedAs: "payout", staffName: "Dani Desk" }],
        handedByMethod: [{ method: "cash", amount: 20, count: 1 }],
        owed: [],
        owedByMethod: [],
        owedTotal: 0,
      },
    });
    render(<CashUpSheet data={data} t={staffTranslator("en")} time={(at) => at.slice(11, 16)} />);
    const block = screen.getByTestId("cash-up-refunds");
    expect(block.textContent).toContain("Dani Desk");
    expect(block.textContent).toContain("−RM20");
    expect(block.textContent).toContain("Nothing is owed back.");
    expect(block.textContent).not.toContain("counted by its credit note");
  });

  it("says an older payout is counted by its credit note", () => {
    const data = sheet({
      refunds: {
        handed: [{ at: "2026-03-10T05:00:00.000Z", kind: "booking", reference: "MS-BBBBBB", creditNote: null, amount: 20, method: "cash", paidWith: "cash", countedAs: "credit note", staffName: "Dani Desk" }],
        handedByMethod: [],
        owed: [],
        owedByMethod: [],
        owedTotal: 0,
      },
    });
    render(<CashUpSheet data={data} t={staffTranslator("ms")} time={(at) => at.slice(11, 16)} />);
    expect(screen.getByTestId("cash-up-refunds").textContent).toContain("dikira melalui nota kreditnya");
  });

  it("shows no refunds block on a day with none", () => {
    render(<CashUpSheet data={sheet({ refunds: { handed: [], handedByMethod: [], owed: [], owedByMethod: [], owedTotal: 0 } })} t={staffTranslator("en")} time={(at) => at} />);
    expect(screen.queryByTestId("cash-up-refunds")).toBeNull();
  });
});
