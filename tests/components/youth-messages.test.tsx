// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import MessagesPage from "../../src/app/messages/page";
import { Thread } from "../../src/app/messages/Thread";
import { MessageReportsPanel } from "../../src/components/admin/MessageReportsPanel";
import { YouthGroupsPanel } from "../../src/components/admin/YouthGroupsPanel";
import GuardianMessaging from "../../src/components/GuardianMessaging";
import { LanguageProvider } from "../../src/components/Language";
import { YouthGroupPanel } from "../../src/components/YouthGroupPanel";

/**
 * The screens of supervised youth groups (docs/features/player-messages.md#supervised-youth-groups): a child's first-use screen, the
 * guardian's controls, the organiser's advanced settings, the supervisor's tools in a conversation, and the staff panel.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => body });
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/messages");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactNode) => render(<LanguageProvider locale="en">{ui}</LanguageProvider>);
const settings = (over = {}) => ({ enabled: false, emailNotices: true, explained: false, adult: false, noticeMode: "digest", youth: true, digestHours: 6, ...over });

describe("a child's first-use screen", () => {
  it("says who can read the messages, and offers the opt-in only after it is read, never a private conversation", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (String(u) === "/api/messages/youth" && init?.method === "POST") return json({ ok: true, eligible: true, linked: true, groups: [{ groupId: 4, name: "Sunday juniors", sport: "badminton", supervisors: [{ name: "Orla", declaredRole: "organiser" }], optedIn: true, guardianOn: true, active: true }] });
      if (String(u) === "/api/messages/youth")
        return json({ eligible: true, linked: true, groups: [{ groupId: 4, name: "Sunday juniors", sport: "badminton", supervisors: [{ name: "Orla", declaredRole: "organiser" }], optedIn: false, guardianOn: true, active: false }] });
      return json({ settings: settings(), threads: [], unread: 0 });
    });
    wrap(<MessagesPage />);
    await act(async () => {});
    expect(screen.getByText("Messages in your group")).toBeTruthy();
    expect(screen.getByText(/and never to one person privately/)).toBeTruthy();
    expect(screen.getByText(/A supervisor can read every message/)).toBeTruthy();
    expect(screen.getByText(/Your guardian is told if you report something/)).toBeTruthy();
    expect(screen.getByText("Supervised by Orla")).toBeTruthy();
    expect(screen.getByText("Your guardian has switched this on.")).toBeTruthy();
    // No way to start a conversation with a person, and no adult's switch.
    expect(screen.queryByText("Turn on messages")).toBeNull();
    const optIn = screen.getByText("Turn on messages in this group") as HTMLButtonElement;
    expect(optIn.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I have read this and want to turn messages on in this group."));
    expect(optIn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(optIn);
    });
    expect(bodyOf(posts()[0])).toEqual({ groupId: 4, on: true });
    expect(screen.getByText("Messages are on in this group.")).toBeTruthy();
    expect(screen.getByText("Open the conversation")).toBeTruthy();
  });

  it("tells a child with nobody linked that a guardian has to be", async () => {
    fetchMock.mockImplementation(async (u: string) =>
      String(u) === "/api/messages/youth"
        ? json({ eligible: true, linked: false, groups: [{ groupId: 4, name: "Sunday juniors", sport: "badminton", supervisors: [], optedIn: false, guardianOn: false, active: false }] })
        : json({ settings: settings(), threads: [], unread: 0 })
    );
    wrap(<MessagesPage />);
    await act(async () => {});
    expect(screen.getByText(/Messages need a guardian who manages your record/)).toBeTruthy();
    expect(screen.queryByText("Turn on messages in this group")).toBeNull();
  });
});

describe("the guardian's controls", () => {
  const child = (over = {}) => ({
    participantId: 9,
    displayName: "Aina Lee",
    hasLogin: true,
    noticeMode: "digest",
    groups: [
      {
        groupId: 4, name: "Sunday juniors", supervisors: [{ name: "Orla", declaredRole: "organiser" }], adults: [{ name: "Olly", declaredRole: "coach" }],
        consentOn: false, childOptedIn: true, active: false, blocked: [], others: [{ userId: 31, label: { n: "Bo T." } }],
        ...over,
      },
    ],
  });

  it("shows nothing at all to a guardian none of whose children is in a youth group", async () => {
    fetchMock.mockImplementation(async () => json({ children: [{ ...child(), groups: [] }], digestHours: 6 }));
    const { container } = wrap(<GuardianMessaging />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("shows who supervises, switches it on and off for the child, reads the conversation read-only, and blocks for the child, never a supervisor", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ ok: true, children: [child({ consentOn: true, active: true })], digestHours: 6 });
      if (String(u).includes("participantId=9"))
        return json({ ok: true, group: "Sunday juniors", child: "Aina L.", consentOn: true, messages: [{ id: 1, child: false, from: { n: "Orla", r: "supervisor" }, body: "Welcome", at: "2026-11-05 10:00:00" }, { id: 2, child: true, from: { n: "Aina L." }, body: "Hello", at: "2026-11-05 10:05:00" }, { id: 3, child: false, from: { n: "Bo T." }, body: null, removed: true, at: "2026-11-05 10:06:00" }] });
      return json({ children: [child()], digestHours: 6 });
    });
    wrap(<GuardianMessaging />);
    await act(async () => {});
    expect(screen.getByText("Group messages for the children you act for")).toBeTruthy();
    expect(screen.getByText("Supervisors: Orla (organiser)")).toBeTruthy();
    expect(screen.getByText("Other adults in the conversation: Olly (coach)")).toBeTruthy();
    expect(screen.getByText("Messages are off for Aina Lee here.")).toBeTruthy();
    // On: the guardian's explicit switch.
    await act(async () => {
      fireEvent.click(screen.getByText("Switch on for Aina Lee"));
    });
    expect(bodyOf(posts()[0])).toEqual({ action: "consent", participantId: 9, groupId: 4, on: true });
    expect(screen.getByText("Messages are on for Aina Lee here.")).toBeTruthy();
    // Reading: read-only, labelled, the removed message as removed, plain text.
    await act(async () => {
      fireEvent.click(screen.getByText("Read the conversation"));
    });
    expect(screen.getByText("Reading as the guardian of Aina L.")).toBeTruthy();
    expect(screen.getByText(/Read only: nothing you do here writes in the conversation/)).toBeTruthy();
    expect(screen.getByText("Welcome")).toBeTruthy();
    expect(screen.getByText("Message removed by a supervisor")).toBeTruthy();
    // A block for the child is offered for the other member only.
    expect(screen.getAllByText(/^Block /)).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByText("Block Bo T. for Aina Lee"));
    });
    expect(bodyOf(posts()[1])).toEqual({ action: "block", participantId: 9, groupId: 4, userId: 31 });
    // The notice frequency is the guardian's.
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Notices about Aina Lee's group messages"), { target: { value: "off" } });
    });
    expect(bodyOf(posts()[2])).toEqual({ action: "notices", participantId: 9, mode: "off" });
  });
});

describe("the organiser's advanced settings", () => {
  const state = (over = {}) => ({
    groupId: 4, name: "Sunday juniors", marked: false, ended: false, organiser: true, supervisor: true, venue: null, venueRequested: null,
    quiet: { installFrom: "22:00", installTo: "07:00" }, groupQuiet: null, adults: [], candidates: [], minors: 0, openSeats: 0, mutes: [], ...over,
  });

  it("is closed by default, marks the group on a click, and says an adult is in the conversation only if let in", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => (init?.method === "POST" ? json({ ok: true }) : json({ state: state() })));
    wrap(<YouthGroupPanel groupId={4} />);
    await act(async () => {});
    const panel = screen.getByTestId("youth-group-panel") as HTMLDetailsElement;
    expect(panel.open).toBe(false);
    expect(screen.getByText("Supervised youth group (advanced)")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Mark as a supervised youth group"));
    });
    expect(bodyOf(posts()[0])).toEqual({ action: "mark" });
  });

  it("lists the adults with what each said they are, and lets an adult member in with a role; the organiser cannot be removed", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ ok: true })
        : json({ state: state({ marked: true, adults: [{ userId: 1, name: "Orla", role: "supervisor", declaredRole: "organiser" }], candidates: [{ userId: 2, name: "Olly" }], minors: 2, openSeats: 4 }) })
    );
    wrap(<YouthGroupPanel groupId={4} />);
    await act(async () => {});
    expect(screen.getByText("This group is a supervised youth group.")).toBeTruthy();
    expect(screen.getByText("2 young members can write (every consent is on).")).toBeTruthy();
    expect(screen.getByText(/Orla · Supervisor · organiser/)).toBeTruthy();
    expect(screen.queryByText("Remove")).toBeNull();
    fireEvent.change(screen.getByLabelText("Member"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("They say they are"), { target: { value: "coach" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Let an adult member into the conversation"));
    });
    expect(bodyOf(posts()[0])).toEqual({ action: "adult", memberUserId: 2, role: "adult", declaredRole: "coach" });
  });

  it("renders nothing for somebody who is not the organiser", async () => {
    fetchMock.mockImplementation(async () => json({ state: state({ organiser: false }) }));
    const { container } = wrap(<YouthGroupPanel groupId={4} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });
});

describe("a supervisor's tools in the conversation", () => {
  const info = { kind: "group", id: 4, venueId: null, venueName: null, name: "Sunday juniors", sport: "badminton", date: null, startMin: null, ended: false, endedAt: null, youth: true };
  const view = (role: string, over = {}) => ({
    kind: "group", id: 4, info, phase: "open", people: 3, canSend: true, whyNot: null, muted: false, threadId: 8,
    messages: [{ id: 1, mine: false, from: { n: "Aina L." }, body: "hello", at: "2026-11-05 10:00:00" }, { id: 2, mine: false, from: { n: "Bo T." }, body: null, removed: true, at: "2026-11-05 10:01:00" }],
    latestId: 2, youth: { role, supervisors: ["Orla"], quiet: null, youthMaxLength: 300, muted: [{ id: 5, label: { n: "Bo" }, source: "supervisor" }] }, ...over,
  });

  it("gives a supervisor the tools and a child none, and shows the banner that says who can read", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => (init?.method === "POST" ? json({ ok: true }) : json(view("supervisor"))));
    wrap(<Thread kind="group" id={4} onBack={() => {}} />);
    await act(async () => {});
    expect(screen.getByTestId("youth-banner").textContent).toContain("Supervisors: Orla");
    expect(screen.getByText("Message removed by a supervisor")).toBeTruthy();
    expect(screen.getByTestId("supervisor-tools")).toBeTruthy();
    expect(screen.getByText("Remove message")).toBeTruthy();
    fireEvent.click(screen.getByText("Remove message"));
    fireEvent.change(screen.getByLabelText("Why? (kept in the group's record)", { selector: "input[required]" }), { target: { value: "Off topic" } });
    await act(async () => {
      fireEvent.click(screen.getAllByText("Remove message")[1]);
    });
    expect(posts().map(bodyOf)[0]).toEqual({ action: "removeMessage", messageId: 1, reason: "Off topic" });
    await act(async () => {
      fireEvent.click(screen.getByText("Lift"));
    });
    expect(posts().map(bodyOf).at(-1)).toEqual({ action: "unmute", muteId: 5 });
  });

  it("shows a child the banner and the shorter limit, and none of the supervisor's tools", async () => {
    fetchMock.mockImplementation(async () => json(view("minor", { youth: { role: "minor", supervisors: ["Orla"], quiet: null, youthMaxLength: 300 } })));
    wrap(<Thread kind="group" id={4} onBack={() => {}} />);
    await act(async () => {});
    expect(screen.getByTestId("youth-banner").textContent).toContain("Supervisors and your guardian can read these messages.");
    expect(screen.queryByTestId("supervisor-tools")).toBeNull();
    expect(screen.queryByText("Remove message")).toBeNull();
    // The report button is on every message from somebody else.
    expect(screen.getAllByText("Report")).toHaveLength(1);
    expect(screen.getByText("0 of 300")).toBeTruthy();
  });

  it("says when the rest hours are why a child cannot write", async () => {
    fetchMock.mockImplementation(async () => json(view("minor", { canSend: false, whyNot: "PM_YOUTH_QUIET", youth: { role: "minor", supervisors: ["Orla"], quiet: { from: "22:00", to: "07:00" }, youthMaxLength: 300 } })));
    wrap(<Thread kind="group" id={4} onBack={() => {}} />);
    await act(async () => {});
    expect(screen.getAllByText("Messages rest between 22:00 and 07:00.").length).toBeGreaterThan(0);
  });
});

describe("the staff panel", () => {
  const group = (over = {}) => ({
    groupId: 4, name: "Sunday juniors", organiser: "Orla", pending: false, ended: false, venueId: 1, supervisors: [{ name: "Orla", declaredRole: "organiser" }], adults: [],
    minors: 2, threadId: 8, threadState: "open", messages: 14, openReports: 1, ...over,
  });

  it("is not shown at all where no group has asked, answers a request, and reads a conversation with the reading recorded", async () => {
    fetchMock.mockImplementation(async () => json({ groups: [] }));
    const { container } = render(<YouthGroupsPanel />);
    await act(async () => {});
    expect(container.textContent).toBe("");

    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ ok: true });
      if (String(u).includes("group=5")) return json({ ok: true, group: "Tuesday group", messages: [{ id: 1, from: { n: "Orla", r: "supervisor" }, body: "Welcome", removed: false, at: "2026-11-05 10:00:00" }, { id: 2, from: { n: "Bo T." }, body: "the words", removed: true, at: "2026-11-05 10:01:00" }] });
      return json({ groups: [group({ pending: true, venueId: null }), group({ groupId: 5, name: "Tuesday group" })] });
    });
    const second = render(<YouthGroupsPanel />);
    await act(async () => {});
    expect(second.getAllByText("Supervised youth groups").length).toBeGreaterThan(0);
    expect(screen.getByText("Asked your venue to look after it")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Accept"));
    });
    expect(bodyOf(posts()[0])).toEqual({ action: "answer", groupId: 4, accept: true });
    await act(async () => {
      fireEvent.click(screen.getByText("Read the conversation (recorded)"));
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/admin/youth-groups?group=5")).toBe(true);
    expect(screen.getByText(/You are reading this for moderation and safeguarding review/)).toBeTruthy();
    expect(screen.getByText("the words")).toBeTruthy();
    expect(screen.getByText(/removed by a supervisor/)).toBeTruthy();
  });
});

describe("guardians who disagree (ADR 0049)", () => {
  const view = (authority: string, over = {}) => ({
    participantId: 9, displayName: "Aina Lee", hasLogin: true, noticeMode: "digest", authority,
    groups: [{ groupId: 4, name: "Sunday juniors", supervisors: [], adults: [], consentOn: false, myConsent: false, needsAgreement: false, childOptedIn: true, active: false, blocked: [], others: [], ...over }],
  });

  it("says only that messaging is off and needs agreement from all guardians who decide, and what this guardian has done", async () => {
    fetchMock.mockImplementation(async () => json({ children: [view("decides", { needsAgreement: true, myConsent: true })], digestHours: 6 }));
    wrap(<GuardianMessaging />);
    await act(async () => {});
    expect(screen.getByText("Messaging for Aina Lee here is off and needs agreement from all guardians who decide.")).toBeTruthy();
    expect(screen.getByText("You have agreed. Messaging stays off until the other guardians who decide agree too.")).toBeTruthy();
    expect(screen.getByText(/stays off until all guardians who decide agree again, or the venue settles it/)).toBeTruthy();
    // Having agreed, the guardian may still take it back.
    expect(screen.getByText("Switch off for Aina Lee")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/objector|who objected/i);
  });

  it("offers a guardian who may only object a switch-off and never a switch-on", async () => {
    fetchMock.mockImplementation(async () => json({ children: [view("objects_only")], digestHours: 6 }));
    wrap(<GuardianMessaging />);
    await act(async () => {});
    expect(screen.getByText("You can switch messaging off for Aina Lee. You cannot switch it on.")).toBeTruthy();
    expect(screen.queryByText("Switch on for Aina Lee")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText("Switch off for Aina Lee"));
    });
    expect(bodyOf(posts()[0])).toEqual({ action: "consent", participantId: 9, groupId: 4, on: false });
  });

  it("shows safeguarding administrators who objected, each guardian's level and note, records a level and settles a hold with a reason", async () => {
    const groups = [{ groupId: 4, name: "Sunday juniors", organiser: "Orla", pending: false, ended: false, venueId: 1, supervisors: [], adults: [], minors: 1, threadId: 8, threadState: "open", messages: 3, openReports: 0 }];
    const children = [
      {
        participantId: 9, child: "Aina L.", consentInForce: false,
        objection: { id: 12, at: "2026-11-05 10:00:00", by: "Gia", level: "decides" },
        guardians: [
          { guardianshipId: 21, name: "Gia", authority: "decides", consentLive: false, note: null, setBy: null, setAt: null },
          { guardianshipId: 22, name: "Gus", authority: "objects_only", consentLive: false, note: "Shown a contact order", setBy: "Mia Manager", setAt: "2026-11-05 09:00:00" },
        ],
      },
    ];
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ ok: true });
      if (String(u).includes("safeguarding=4")) return json({ ok: true, group: "Sunday juniors", children });
      return json({ groups });
    });
    render(<YouthGroupsPanel />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByText("Guardians and holds on messaging"));
    });
    expect(screen.getByText(/Messaging is on hold since .*: a guardian \(Gia, decides \(may agree and object\)\) switched it off/)).toBeTruthy();
    expect(screen.getByText(/Recorded as the venue's word, never verified by the app/)).toBeTruthy();
    // Settling needs a reason, and says it does not switch messaging on.
    expect(screen.getByText(/It does not switch messaging on/)).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText(/Reason/)[0], { target: { value: "Settled with both families" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Settle the hold"));
    });
    expect(bodyOf(posts()[0])).toEqual({ action: "resolve", objectionId: 12, reason: "Settled with both families" });
    // A level is recorded with its note.
    fireEvent.change(screen.getAllByLabelText(/What this guardian may do about messaging/)[0], { target: { value: "none" } });
    await act(async () => {
      fireEvent.click(screen.getAllByText("Record")[0]);
    });
    expect(bodyOf(posts()[1])).toEqual({ action: "authority", guardianshipId: 21, level: "none", note: "" });
  });
});

describe("a report in a youth thread is a case (ADR 0049)", () => {
  const report = {
    id: 5, createdAt: "2026-11-05 10:00:00", status: "open", outcome: null, reason: "abuse", note: null, kind: "group", contextId: 4, venueId: null, threadId: 8, threadState: "open",
    urgent: true, linesHeld: true, escalated: false, restricted: true, reporter: { n: "Aina L." }, reported: { userId: 7, label: { n: "Alan", r: "adult" }, suspended: false, reporters: 1 },
    reviewedBy: null, reviewedAt: null, lines: [],
  };
  const caseOut = {
    id: 5, createdAt: report.createdAt, status: "open", outcome: null, reason: "abuse", note: null, groupId: 4, venueId: null, reporter: { n: "Aina L." },
    reported: { userId: 7, label: { n: "Alan" }, adult: true }, restricted: true, escalated: null,
    lines: [{ id: 1, from: { n: "Alan" }, body: "the flagged words", at: "2026-11-05 09:59:00", flagged: true }], notes: [{ id: 1, action: "read", by: "Olive", detail: null, at: "2026-11-05 10:01:00" }],
  };

  it("holds the evidence back until it is opened, says the restriction is not a finding, and tells the reported adult only in the moderator's words", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ ok: true });
      if (String(u).includes("report=5")) return json({ ok: true, case: caseOut });
      return json({ reports: [report], suspensions: [], scope: "platform" });
    });
    render(<MessageReportsPanel />);
    await act(async () => {});
    expect(screen.getByText(/protective and is not a finding of fault/)).toBeTruthy();
    expect(screen.queryByText("the flagged words")).toBeNull();
    // Opening it reads the evidence (recorded), and shows what has been done.
    await act(async () => {
      fireEvent.click(screen.getByText("Open the case and read the evidence (recorded)"));
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/admin/message-moderation?report=5")).toBe(true);
    expect(screen.getByText("the flagged words")).toBeTruthy();
    expect(screen.getByText(/Olive · read the evidence/)).toBeTruthy();
    // The one way the reported adult is told: the moderator's own words.
    fireEvent.change(screen.getByLabelText(/Tell the reported adult/), { target: { value: "Your access is paused while we review something." } });
    expect(screen.getByText(/Do not name who reported or repeat what was reported/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Send this to the reported adult"));
    });
    expect(posts().map(bodyOf)).toContainEqual({ action: "case", id: 5, step: "notify", text: "Your access is paused while we review something." });
    // The review has a third outcome for a report in a youth thread.
    await act(async () => {
      fireEvent.click(screen.getByText("Dealt with, restriction continues"));
    });
    expect(posts().map(bodyOf)).toContainEqual({ action: "review", id: 5, outcome: "restriction_continues" });
  });
});
