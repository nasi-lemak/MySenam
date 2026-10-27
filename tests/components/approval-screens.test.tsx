// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ApprovalForm, type ApplyInfo } from "../../src/components/ApprovalForm";
import { ApprovalsReview } from "../../src/components/admin/ApprovalsPanel";
import ApprovalsPage from "../../src/app/account/approvals/page";
import type { ApprovalRequest } from "../../src/lib/approvals";

/**
 * The screens of online applications for activity approval
 * (lib/approvals.ts): the customer's form (their own, a minor's with a
 * guardian, or for somebody they manage, each declared, not verified), the
 * reviewers' list on the dashboard (what each decision sends, a reason asked
 * for a refusal, a refusal from the server shown), and the customer's own
 * page (signed out, a question to answer, a refusal and applying again).
 */

let fetchMock: ReturnType<typeof vi.fn>;
let calls: { url: string; init?: RequestInit }[];
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function stub(handler: (url: string, init?: RequestInit) => { ok: boolean; status: number; json: () => Promise<unknown> }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** The application's fields as the form posts them (multipart: a `data` part, then the documents). */
function posted(i = 0): { data: Record<string, unknown>; documents: File[] } {
  const form = calls.filter((c) => c.init?.method === "POST")[i].init!.body as FormData;
  return { data: JSON.parse(String(form.get("data"))), documents: form.getAll("document") as File[] };
}

const INFO: ApplyInfo = {
  venueId: 4,
  venueName: "Pusat Memanah",
  sport: "archery",
  kind: "operational",
  intro: "Range safety first.",
  declaration: "I will follow the range officer's calls.",
  documentLabel: null,
  videoUrl: null,
  inPerson: null,
  questions: [
    { id: "q1", text: "Have you shot before?", required: true },
    { id: "q2", text: "Anything else?", required: false },
  ],
  validDays: 365,
  holdHours: 48,
  courts: [{ id: 9, name: "Range A" }],
  waiverText: "Archery is dangerous; I take part at my own risk.",
  adult: null,
  waiverForOthers: "Archery is dangerous; the child takes part at the guardian's risk.",
  people: [],
};

async function submit() {
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: "Send application" }).closest("form")!);
  });
}

describe("applying for an activity", () => {
  it("sends the answers, the declaration, the waiver, a declared adult and the slot asked for", async () => {
    stub(() => json({ ok: true }));
    const done = vi.fn();
    render(<ApprovalForm info={INFO} onDone={done} />);
    expect(screen.getByText("Apply for Archery at Pusat Memanah")).toBeTruthy();
    expect(screen.getByText("Range safety first.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Have you shot before\?/), { target: { value: "Twice, at a club" } });
    fireEvent.click(screen.getByLabelText("I will follow the range officer's calls."));
    fireEvent.click(screen.getByLabelText("I agree to the venue's waiver above."));
    fireEvent.click(screen.getByLabelText("I am 18 or over"));
    fireEvent.change(screen.getByLabelText("Where"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-11-20" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("Until"), { target: { value: "11:30" } });
    await submit();
    expect(calls[0].url).toBe("/api/my/approvals");
    const { data, documents } = posted();
    expect(data).toEqual({
      venueId: 4,
      sport: "archery",
      answers: { q1: "Twice, at a club" },
      declaration: true,
      videoWatched: false,
      waiver: true,
      adult: true,
      slot: { courtId: 9, date: "2026-11-20", start: 600, end: 690 },
    });
    expect(documents).toHaveLength(0);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("asks a minor for a parent or guardian's name and agreement, and sends them as declared", async () => {
    stub(() => json({ ok: true }));
    render(<ApprovalForm info={INFO} onDone={() => {}} />);
    expect(screen.queryByPlaceholderText("Parent or guardian's name")).toBeNull();
    fireEvent.click(screen.getByLabelText("I am under 18"));
    const guardian = screen.getByPlaceholderText("Parent or guardian's name") as HTMLInputElement;
    expect(guardian.required).toBe(true);
    fireEvent.change(guardian, { target: { value: "Puan Rohana" } });
    fireEvent.click(screen.getByLabelText("My parent or guardian named here agrees to this application for Archery at Pusat Memanah."));
    await submit();
    expect(posted().data).toMatchObject({ adult: false, guardianName: "Puan Rohana", guardianDeclaration: true, slot: null });
  });

  it("applies for somebody the adult manages: their authority declared, the waiver agreed on the child's behalf, no age asked of the adult", async () => {
    stub(() => json({ ok: true }));
    render(<ApprovalForm info={{ ...INFO, people: [{ id: 31, displayName: "Aisyah", relationship: "parent" }] }} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Who is this application for?"), { target: { value: "31" } });
    expect(screen.queryByText("Your age")).toBeNull();
    expect(screen.getByText("Archery is dangerous; the child takes part at the guardian's risk.")).toBeTruthy();
    expect(screen.queryByText("Archery is dangerous; I take part at my own risk.")).toBeNull();
    fireEvent.click(screen.getByLabelText("I agree to the venue's waiver above on Aisyah's behalf."));
    fireEvent.click(screen.getByLabelText("I am Aisyah's parent and have the authority to apply for them; I agree to this application on their behalf."));
    expect(screen.getByText(/Recorded as you declare it, not verified/)).toBeTruthy();
    await submit();
    const { data } = posted();
    expect(data).toMatchObject({ forPerson: 31, authority: true, waiver: true });
    expect(data).not.toHaveProperty("adult");
    expect(data).not.toHaveProperty("guardianName");
  });

  it("asks for the document the venue needs, saying why, and sends at most three", async () => {
    stub(() => json({ ok: true }));
    render(<ApprovalForm info={{ ...INFO, documentLabel: "your club's coaching certificate", documentPurpose: "to check you have shot under supervision" }} onDone={() => {}} />);
    const input = screen.getByLabelText(/your club's coaching certificate/) as HTMLInputElement;
    expect(input.required).toBe(true);
    expect(input.accept).toBe("application/pdf,image/jpeg,image/png,image/webp");
    expect(screen.getByText(/to check you have shot under supervision/)).toBeTruthy();
    const files = [1, 2, 3, 4].map((i) => new File([`%PDF-1.7 ${i}`], `c${i}.pdf`, { type: "application/pdf" }));
    fireEvent.change(input, { target: { files } });
    await submit();
    expect(posted().documents.map((f) => f.name)).toEqual(["c1.pdf", "c2.pdf", "c3.pdf"]);
  });

  it("says why the venue refused it, in the customer's words, and stays open", async () => {
    stub(() => json({ ok: false, error: "You already have an application waiting for this activity here.", code: "APR_ALREADY_LIVE" }, 409));
    const done = vi.fn();
    render(<ApprovalForm info={INFO} onDone={done} />);
    await submit();
    expect(screen.getByText("You already have an application waiting for this activity here.")).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
  });
});

/** An application as the review list gives it. */
function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 51,
    requirementId: 2,
    venueId: 4,
    venueName: "Pusat Memanah",
    sport: "archery",
    userId: 8,
    name: "Hafiz Rahman",
    phone: "0123456789",
    status: "pending",
    renewalOf: null,
    answers: { q1: "Twice, at a club" },
    questions: [
      { id: "q1", text: "Have you shot before?", required: true },
      { id: "q2", text: "Anything else?", required: false },
    ],
    kind: "operational",
    inPersonStep: null,
    declaredAt: "2026-10-20T02:00:00Z",
    videoWatchedAt: null,
    waiverSignedAt: "2026-10-20T02:00:00Z",
    declaredAdult: true,
    guardianName: null,
    guardianDeclaredAt: null,
    certReference: null,
    certExpiresOn: null,
    onlineOkAt: null,
    onlineOkBy: null,
    adminCheckedAt: null,
    adminCheckedBy: null,
    inPersonAt: null,
    inPersonBy: null,
    expiresAt: "2026-11-03T02:00:00Z",
    decidedAt: null,
    validUntil: null,
    lapsed: false,
    revoked: false,
    revokeReason: null,
    slot: null,
    bookingCode: null,
    documents: [],
    events: [{ at: "2026-10-20T02:00:00Z", actorName: "Hafiz Rahman", action: "submitted", reason: null }],
    createdAt: "2026-10-20T02:00:00Z",
    forPerson: null,
    appliedBy: null,
    authorityDeclaredAt: null,
    guardianCheck: false,
    authorityReviewedAt: null,
    authorityReviewedBy: null,
    ...over,
  } as ApprovalRequest;
}

describe("reviewing applications on the dashboard", () => {
  let requests: ApprovalRequest[];
  let decide: { status: number; body: unknown };
  beforeEach(() => {
    requests = [request()];
    decide = { status: 200, body: { ok: true } };
    stub((url, init) => (init?.method === "POST" ? json(decide.body, decide.status) : json({ requests })));
  });
  const decisions = () => calls.filter((c) => c.init?.method === "POST").map((c) => JSON.parse(String(c.init!.body)));
  const review = async () => {
    render(<ApprovalsReview venueId={4} />);
    await act(async () => {});
  };
  const click = async (name: string) => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  };

  it("shows what the customer answered and declared, age as declared and not verified", async () => {
    await review();
    expect(calls[0].url).toBe("/api/admin/approvals?venueId=4");
    expect(screen.getByText(/Archery · Hafiz Rahman · 0123456789/)).toBeTruthy();
    expect(screen.getByText("Waiting for review")).toBeTruthy();
    expect(screen.getByText("Twice, at a club")).toBeTruthy();
    expect(screen.getByText("left blank")).toBeTruthy();
    expect(screen.getByText(/18 or over/).textContent).toContain("as declared, not verified");
  });

  it("approves, sending the venue and the application and nothing else, then reads the list again", async () => {
    await review();
    await click("Approve");
    expect(decisions()).toEqual([{ venueId: 4, id: 51, action: "approve", reason: null }]);
    expect(calls.filter((c) => !c.init?.method)).toHaveLength(2);
  });

  it("asks why before refusing, and refuses nothing without a reason", async () => {
    const prompt = vi.fn<(message?: string) => string | null>(() => null);
    vi.stubGlobal("prompt", prompt);
    await review();
    await click("Refuse");
    expect(prompt).toHaveBeenCalledWith("Why is Hafiz Rahman's application refused? They are told.");
    prompt.mockReturnValue("   ");
    await click("Refuse");
    expect(decisions()).toHaveLength(0);
    prompt.mockReturnValue("No club experience on record.");
    await click("Refuse");
    expect(decisions()).toEqual([{ venueId: 4, id: 51, action: "reject", reason: "No club experience on record." }]);
  });

  it("says the server's refusal: a safety assessment the front desk may not grant", async () => {
    decide = {
      status: 403,
      body: {
        error: "This is a safety assessment: a manager, a coach named for this activity, or staff delegated for it decides. You can ask for more, record the administrative check, or refuse.",
        code: "APR_SAFETY_AUTHORITY",
      },
    };
    await review();
    await click("Approve");
    expect(screen.getByText(/This is a safety assessment/)).toBeTruthy();
  });

  it("offers the in-person step apart from accepting the online part", async () => {
    requests = [request({ inPersonStep: "a range induction with the officer" })];
    await review();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    vi.stubGlobal("prompt", () => "Induction done on range A");
    await click("Record the in-person step");
    await click("Accept the online part");
    expect(decisions()).toEqual([
      { venueId: 4, id: 51, action: "in_person", reason: "Induction done on range A" },
      { venueId: 4, id: 51, action: "approve", reason: null },
    ]);
  });

  it("shows an application for a child as made by the adult, as declared, and waits for their authority to be reviewed where the venue asks", async () => {
    requests = [
      request({
        name: "Aisyah",
        forPerson: { id: 31, name: "Aisyah", relationship: "parent", birthYear: 2015 },
        appliedBy: "Nurul Huda",
        authorityDeclaredAt: "2026-10-20T02:00:00Z",
        guardianCheck: true,
      }),
    ];
    await review();
    expect(screen.getByText(/Applied by Nurul Huda \(declared parent\) for Aisyah/).textContent).toContain("declared by the adult, not verified");
    expect(screen.getByText("Approval waits for a reviewer to record that they reviewed the adult's authority.")).toBeTruthy();
    vi.stubGlobal("prompt", () => "");
    await click("Record authority reviewed");
    expect(decisions()).toEqual([{ venueId: 4, id: 51, action: "authority", reason: "" }]);
  });

  it("offers approving without holding the slot for payment only where a slot is held, as an exception on record", async () => {
    await review();
    expect(screen.queryByLabelText(/Approve without holding the slot for payment/)).toBeNull();
    cleanupAnd();
    requests = [request({ slot: { courtId: 9, courtName: "Range A", date: "2026-11-20", start: 600, end: 660, holdUntil: "2026-10-22T02:00:00Z", status: "held", payBy: null, due: null } })];
    await review();
    expect(screen.getByText(/Range A · 2026-11-20 10:00 AM–11:00 AM/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Approve without holding the slot for payment/));
    await click("Approve");
    expect(decisions()).toEqual([{ venueId: 4, id: 51, action: "approve", reason: null, payLater: true }]);
  });

  it("offers only taking back an approval that stands", async () => {
    requests = [request({ status: "approved", validUntil: "2027-10-20", decidedAt: "2026-10-21T02:00:00Z" })];
    await review();
    expect(screen.getByText("Approved")).toBeTruthy();
    for (const name of ["Approve", "Refuse", "Ask for more"]) expect(screen.queryByRole("button", { name })).toBeNull();
    vi.stubGlobal("prompt", () => "Unsafe on the range on 25 October");
    await click("Revoke the approval");
    expect(decisions()).toEqual([{ venueId: 4, id: 51, action: "revoke", reason: "Unsafe on the range on 25 October" }]);
  });
});

/** Unmounts what is rendered, for a second render in the same test. */
function cleanupAnd() {
  cleanup();
}

describe("the customer's approvals page", () => {
  it("asks a signed-out visitor to sign in, coming back to the same page", async () => {
    window.history.replaceState(null, "", "/account/approvals?venueId=4&sport=archery");
    stub(() => json({ error: "Sign in first." }, 401));
    render(<ApprovalsPage />);
    await act(async () => {});
    expect(screen.getByText(/Sign in to apply: an approval is personal/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(`/login?next=${encodeURIComponent("/account/approvals?venueId=4&sport=archery")}`);
  });

  it("shows the venue's question, and sends the answer back for review", async () => {
    const asked = request({
      status: "info_requested",
      events: [
        { at: "2026-10-20T02:00:00Z", actorName: "Hafiz Rahman", action: "submitted", reason: null },
        { at: "2026-10-21T02:00:00Z", actorName: "Coach Lim", action: "asked", reason: "Which club did you shoot at?" },
      ],
    } as Partial<ApprovalRequest>);
    stub((url, init) => (init?.method === "POST" ? json({ ok: true }) : url === "/api/my/reviews" ? json({ requests: [] }) : json({ requests: [asked], courts: {} })));
    render(<ApprovalsPage />);
    await act(async () => {});
    const card = screen.getByText(/Archery at Pusat Memanah/).closest("li")!;
    expect(within(card).getByText("Coach Lim asks:")).toBeTruthy();
    expect(within(card).getByText("Which club did you shoot at?")).toBeTruthy();
    fireEvent.change(card.querySelector("textarea")!, { target: { value: "Kelab Memanah Shah Alam" } });
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Send answer" }));
    });
    const sent = calls.find((c) => c.init?.method === "POST")!;
    expect(sent.url).toBe("/api/my/approvals/51");
    expect(JSON.parse(String(sent.init!.body))).toEqual({ action: "answer", answer: "Kelab Memanah Shah Alam" });
    expect(screen.getByText("Answer sent. It goes back for review.")).toBeTruthy();
  });

  it("says why an application was refused, and offers applying again", async () => {
    const refused = request({
      status: "rejected",
      events: [{ at: "2026-10-21T02:00:00Z", actorName: "Manager", action: "rejected", reason: "No club experience on record." }],
    } as Partial<ApprovalRequest>);
    stub((url) => (url === "/api/my/reviews" ? json({ requests: [] }) : json({ requests: [refused], courts: {} })));
    render(<ApprovalsPage />);
    await act(async () => {});
    expect(screen.getByText("The venue refused this application.")).toBeTruthy();
    expect(screen.getByText("Why: No club experience on record.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Apply again" }).getAttribute("href")).toBe("/account/approvals?venueId=4&sport=archery");
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("does not offer the form where the venue takes no applications online, nor a second one while one is waiting", async () => {
    window.history.replaceState(null, "", "/account/approvals?venueId=4&sport=archery");
    stub((url) => (url === "/api/my/reviews" ? json({ requests: [] }) : json({ requests: [], courts: {}, apply: null })));
    render(<ApprovalsPage />);
    await act(async () => {});
    expect(screen.getByText("This venue does not take applications for that activity online. Ask at the counter.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send application" })).toBeNull();
    cleanupAnd();

    stub((url) => (url === "/api/my/reviews" ? json({ requests: [] }) : json({ requests: [request()], courts: {}, apply: INFO })));
    render(<ApprovalsPage />);
    await act(async () => {});
    expect(screen.getByText(/Archery at Pusat Memanah/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send application" })).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeTruthy();
  });
});
