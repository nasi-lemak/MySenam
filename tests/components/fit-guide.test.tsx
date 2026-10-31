// @vitest-environment jsdom
import fs from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";

import FitGuide from "../../src/components/fit/FitGuide";
import FitPicker from "../../src/components/fit/FitPicker";
import IllustrativeScreen from "../../src/components/fit/IllustrativeScreen";
import Walkthrough, { type WalkthroughText } from "../../src/components/fit/Walkthrough";
import WorkflowTabs from "../../src/components/fit/WorkflowTabs";
import { translator } from "../../src/lib/i18n";
import { presentWorkflows } from "../../src/lib/guide/public/present";
import { fitView } from "../../src/lib/guide/public/view";

/**
 * The guide's interactive parts (docs/features/venue-guide.md#the-public-guide):
 * a stepper and tabs that are plain lists until the page has loaded, then
 * keyboard-operable with focus that follows; screens that say their state in
 * words; fields with names; targets a thumb can hit.
 */

const t = translator("en");
const view = fitView({ types: ["badminton-and-pickleball"], activities: [] });
const journeys = presentWorkflows(view, t);
const booking = journeys.find((w) => w.id === "court-booking")!;
const TEXT: WalkthroughText = {
  stepN: t("fit.step.n"),
  previous: t("fit.step.prev"),
  next: t("fit.step.next"),
  sees: t("fit.label.sees"),
  checks: t("fit.label.checks"),
  relies: t("fit.label.relies"),
  notSupported: t("fit.label.notSupported"),
  instead: t("fit.label.instead"),
  illustration: t("fit.illustration"),
  screenOf: t("fit.screen.of"),
};

/** The panel of each step, in order. */
const panels = (c: HTMLElement) => [...c.querySelectorAll("ol > li > div[id]")] as HTMLElement[];

describe("the walkthrough", () => {
  it("is a plain list before the page has loaded: every step open, no stepper controls, nothing hidden", () => {
    const markup = renderToString(<Walkthrough steps={booking.steps} text={TEXT} />);
    const doc = new DOMParser().parseFromString(markup, "text/html");
    expect(doc.querySelectorAll("ol > li").length).toBe(booking.steps.length);
    expect(doc.querySelectorAll("[hidden]").length).toBe(0);
    expect(doc.querySelectorAll("button").length).toBe(0);
    for (const s of booking.steps) {
      expect(doc.body.textContent).toContain(s.title);
      expect(doc.body.textContent).toContain(s.sees);
      expect(doc.body.textContent).toContain(s.checks);
    }
  });

  it("becomes a stepper once loaded: one step open, the headings buttons that say so, Previous disabled at the start", () => {
    const { container } = render(<Walkthrough steps={booking.steps} text={TEXT} />);
    const heads = [...container.querySelectorAll("h4 button")] as HTMLButtonElement[];
    expect(heads.length).toBe(booking.steps.length);
    expect(heads.map((h) => h.getAttribute("aria-expanded"))).toEqual(booking.steps.map((_, i) => String(i === 0)));
    expect(panels(container).map((p) => p.hidden)).toEqual(booking.steps.map((_, i) => i !== 0));
    expect(heads[0].getAttribute("aria-current")).toBe("step");
    expect(heads[1].getAttribute("aria-current")).toBeNull();
    // Each heading controls a panel that exists.
    for (const h of heads) expect(container.querySelector(`#${CSS.escape(h.getAttribute("aria-controls")!)}`)).not.toBeNull();
    expect((screen.getByRole("button", { name: "Previous step" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(`Step 1 of ${booking.steps.length}`);
  });

  it("moves with Next and Previous, and focus goes to the step that opened", async () => {
    const { container } = render(<Walkthrough steps={booking.steps} text={TEXT} />);
    const heads = [...container.querySelectorAll("h4 button")] as HTMLButtonElement[];
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    await Promise.resolve();
    expect(heads[1].getAttribute("aria-expanded")).toBe("true");
    expect(heads[0].getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(heads[1]);
    expect(screen.getByRole("status").textContent).toBe(`Step 2 of ${booking.steps.length}`);
    expect((screen.getByRole("button", { name: "Previous step" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Previous step" }));
    await Promise.resolve();
    expect(document.activeElement).toBe(heads[0]);
    // To the last step, where Next stops.
    for (let i = 0; i < booking.steps.length - 1; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Next step" }));
      await Promise.resolve();
    }
    expect((screen.getByRole("button", { name: "Next step" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(heads[booking.steps.length - 1]);
  });

  it("opens the step whose heading is pressed, and names the capabilities the step rests on and what it says is not there", () => {
    const { container } = render(<Walkthrough steps={booking.steps} text={TEXT} />);
    const heads = [...container.querySelectorAll("h4 button")] as HTMLButtonElement[];
    fireEvent.click(heads[2]);
    expect(heads[2].getAttribute("aria-expanded")).toBe("true");
    expect(panels(container)[2].hidden).toBe(false);
    expect(panels(container)[2].textContent).toContain("Relies on:");
    // A step with a limit says it as one, with what to do instead.
    const cancel = journeys.find((w) => w.id === "cancellation-and-refund")!;
    const settle = render(<Walkthrough steps={cancel.steps} text={TEXT} />);
    fireEvent.click(within(settle.container).getByRole("button", { name: /What goes back/ }));
    expect(settle.container.textContent).toContain("Not supported: Billplz refunds and subscriptions");
    expect(settle.container.textContent).toContain("What to do instead");
  });

  it("is a vertical list on a phone: no fixed widths, only the steps' own wrapping", () => {
    const { container } = render(<Walkthrough steps={booking.steps} text={TEXT} />);
    expect(container.innerHTML).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d|\bwidth:\s*\d/);
    expect(container.innerHTML).toMatch(/md:grid-cols-2/);
  });
});

describe("the journey tabs", () => {
  const items = ["one", "two", "three"].map((id) => ({ id, title: `Journey ${id}`, intro: `About ${id}`, from: null, content: <p>{`Content ${id}`}</p> }));

  it("are no tabs before the page has loaded: every journey on the page under its own heading", () => {
    const doc = new DOMParser().parseFromString(renderToString(<WorkflowTabs items={items} label="Journeys" />), "text/html");
    expect(doc.querySelectorAll('[role="tab"]').length).toBe(0);
    expect(doc.querySelectorAll("h3").length).toBe(3);
    expect(doc.querySelectorAll("[hidden]").length).toBe(0);
    for (const i of items) expect(doc.body.textContent).toContain(`Content ${i.id}`);
  });

  it("become a labelled tab list with one tab in the tab order, arrow keys, Home and End, and focus that follows", () => {
    const { container } = render(<WorkflowTabs items={items} label="Journeys" />);
    const list = screen.getByRole("tablist", { name: "Journeys" });
    const tabs = within(list).getAllByRole("tab") as HTMLButtonElement[];
    expect(tabs.map((x) => x.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((x) => x.tabIndex)).toEqual([0, -1, -1]);
    const open = () => [...container.querySelectorAll('[role="tabpanel"]')].filter((p) => !(p as HTMLElement).hidden).map((p) => p.textContent);
    expect(open().length).toBe(1);
    expect(open()[0]).toContain("Content one");
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    expect(open()[0]).toContain("Content two");
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs.map((x) => x.tabIndex)).toEqual([0, -1, -1]);
    // Each tab controls the panel it names, and the panel is named by the tab.
    for (const tab of tabs) {
      const panel = container.querySelector(`#${CSS.escape(tab.getAttribute("aria-controls")!)}`)!;
      expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
    }
    fireEvent.click(tabs[1]);
    expect(open()[0]).toContain("Content two");
  });

  it("show no tab list for a single journey", () => {
    render(<WorkflowTabs items={items.slice(0, 1)} label="Journeys" />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText("Content one")).toBeTruthy();
  });
});

describe("an illustrated screen", () => {
  const lines = [
    { text: "Court 1 · 19:00–20:00 · free · RM40", tone: "ok" as const, as: "row" as const },
    { text: "Court 3 · 19:00–20:00 · taken", tone: "stop" as const, as: "row" as const },
    { text: "Pay online", tone: "plain" as const, as: "action" as const },
    { text: "Total · RM40", tone: "plain" as const, as: "total" as const },
  ];

  it("says it is made up, says each state in words as well as a mark, and has no control that does nothing", () => {
    render(<IllustrativeScreen title="Choose a time" lines={lines} note="Illustration: made-up sample data" label="Illustrated screen: Choose a time" />);
    const fig = screen.getByLabelText("Illustrated screen: Choose a time");
    expect(fig.textContent).toContain("Illustration: made-up sample data");
    expect(fig.textContent).toContain("free");
    expect(fig.textContent).toContain("taken");
    // The marks repeat the words and are hidden from a screen reader.
    const marks = [...fig.querySelectorAll('[aria-hidden="true"]')].map((m) => m.textContent);
    expect(marks).toEqual(expect.arrayContaining(["✓", "✕"]));
    // A picture of a button is not a button: nothing to tab to, nothing to press.
    expect(fig.querySelectorAll("button, a, input").length).toBe(0);
    expect(within(fig).getByRole("img", { name: "Pay online" })).toBeTruthy();
  });
});

describe("the page's controls", () => {
  const picker = renderToString(<FitPicker selection={{ types: ["swimming"], activities: ["yoga"] }} t={t} showCards />);
  const guide = renderToString(<FitGuide view={fitView({ types: ["badminton-and-pickleball", "gym-and-fitness"], activities: ["bowling"] })} t={t} />);

  it("keep every box inside the label that names it", () => {
    const doc = new DOMParser().parseFromString(picker, "text/html");
    const boxes = [...doc.querySelectorAll("input")];
    expect(boxes.length).toBeGreaterThan(40);
    for (const b of boxes) expect(b.closest("label"), b.getAttribute("value") ?? "").not.toBeNull();
    expect(doc.querySelectorAll("fieldset > legend").length).toBeGreaterThanOrEqual(8);
    expect(doc.querySelector('input[value="swimming"]')!.hasAttribute("checked")).toBe(true);
    expect(doc.querySelector('input[value="yoga"]')!.hasAttribute("checked")).toBe(true);
    expect(doc.querySelector("details")!.hasAttribute("open")).toBe(true);
  });

  it("are all at least 36 pixels tall: links, buttons, labels and the disclosure", () => {
    for (const markup of [picker, guide]) {
      const doc = new DOMParser().parseFromString(markup, "text/html");
      const small = [...doc.querySelectorAll("a, button, label, summary")].filter((el) => !/\bmin-h-(9|10|11|12)\b/.test(el.className)).map((el) => el.outerHTML.slice(0, 90));
      expect(small).toEqual([]);
    }
  });

  it("show a state in a word as well as a colour: every availability heading and chip carries its words", () => {
    const doc = new DOMParser().parseFromString(guide, "text/html");
    const text = doc.querySelector("#available")!.textContent!;
    for (const label of ["Available now", "Available with configuration", "Requires an external integration", "Not currently supported"]) expect(text).toContain(label);
    // A chip's mark is decoration beside its title.
    for (const mark of doc.querySelectorAll("#available li > span:first-child")) expect(mark.getAttribute("aria-hidden")).toBe("true");
    // The way on carries the choice, and the privacy line says nothing is stored.
    expect(doc.querySelector('a[href^="/list-your-venue?fit=types:badminton-and-pickleball,gym-and-fitness~activities:"]')).not.toBeNull();
    expect(doc.querySelector("#start")!.textContent).toContain("stores nothing");
  });
});

// The same rule as tests/form-labels.test.ts, for the pages and components this guide adds: a field has a label around it or pointing at it.
function unnamedFields(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pointedAt = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && n.name.getText() === "htmlFor" && n.initializer) pointedAt.add(n.initializer.getText());
    ts.forEachChild(n, collect);
  };
  collect(src);
  const bad: string[] = [];
  const visit = (n: ts.Node, inLabel: boolean) => {
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === "label") {
      ts.forEachChild(n, (c) => visit(c, true));
      return;
    }
    const open = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxElement(n) ? n.openingElement : null;
    if (open && ["input", "select", "textarea"].includes(open.tagName.getText())) {
      const props = open.attributes.properties;
      const attrs = new Map(props.filter(ts.isJsxAttribute).map((a) => [a.name.getText(), a.initializer?.getText() ?? "true"]));
      const type = attrs.get("type")?.replace(/["{}]/g, "");
      const named = inLabel || attrs.has("aria-label") || attrs.has("aria-labelledby") || (attrs.has("id") && pointedAt.has(attrs.get("id")!)) || ["hidden", "submit", "button", "reset"].includes(type ?? "") || props.some(ts.isJsxSpreadAttribute);
      if (!named) bad.push(`${path.basename(file)}:${src.getLineAndCharacterOfPosition(open.getStart()).line + 1} <${open.tagName.getText()}>`);
    }
    ts.forEachChild(n, (c) => visit(c, inLabel));
  };
  visit(src, false);
  return bad;
}

describe("form fields in the guide's own files", () => {
  it("all have names", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const files = [
      ...fs.readdirSync(path.join(root, "src/components/fit")).filter((f) => f.endsWith(".tsx")).map((f) => path.join(root, "src/components/fit", f)),
      path.join(root, "src/app/for-venues/page.tsx"),
      path.join(root, "src/app/for-venues/[type]/page.tsx"),
    ];
    expect(files.length).toBeGreaterThan(5);
    expect(files.flatMap(unnamedFields)).toEqual([]);
  });
});
