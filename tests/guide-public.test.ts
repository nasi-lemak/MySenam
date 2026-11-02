import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { BUILTIN_ACTIVITIES } from "../src/lib/activity-catalogue";
import { DICTIONARIES, LOCALES, translator, type Phrase } from "../src/lib/i18n";
import { BUSINESS_TYPES, BUSINESS_TYPE_IDS, WORKFLOW_IDS, activityFacts, composeTypes } from "../src/lib/guide/business-types";
import { CAPABILITIES, availabilityOf, capability } from "../src/lib/guide/capabilities";
import { normaliseFit } from "../src/lib/guide/answer-schema";
import { actorKey, isLiteral, isMoney, stepChecksKey, stepSeesKey, stepTitleKey, tokenKey } from "../src/lib/guide/public/model";
import { applyAddress, decodeFit, emptySelection, encodeFit, guideAddress, parseSelection, selectionOf } from "../src/lib/guide/public/select";
import { STEPS, SHARED_WORKFLOW_IDS, WORKFLOWS, WORKFLOW_CONTENT_IDS, contentPhraseKeys, screenTokens, shownSteps, stepShown } from "../src/lib/guide/public/workflows";
import { COMBINED_CLAIMS, LIMITS_WITH, MODEL_CAPABILITIES, MODEL_WORKFLOWS, fitView, viewClaims, workflowApplies } from "../src/lib/guide/public/view";
import { lineText, presentCapability, presentChip, presentWorkflows, tokenText } from "../src/lib/guide/public/present";

/**
 * The public guide's content is held to the shared model, and the shared model
 * to the repository's own account of itself (docs/features/venue-guide.md#the-public-guide):
 * a workflow's step relies only on capabilities that exist and are available;
 * a business type's journeys are whole with what it lists; a chip says what
 * `availabilityOf` says; what is not built is said as not built, with what to
 * do instead; and every word is in all four customer languages.
 */

const ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

// The matrix: | Capability | Status | Behaviour | Code | Tests | Gaps |
const rows = new Map<string, { status: string; gaps: string }>();
for (const line of read("docs/product/feature-status.md").split("\n")) {
  if (!/^\|\s*[^-|\s]/.test(line) || line.split("|").length < 8 || /^\|\s*Capability\s*\|/.test(line)) continue;
  const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
  rows.set(cells[1], { status: cells[2], gaps: cells[6] });
}

const AVAILABLE = (id: string) => capability(id)?.status === "available";
const en = translator("en");

describe("the workflows' content", () => {
  it("covers every workflow of the shared model, and only those, each with real steps", () => {
    expect([...WORKFLOW_CONTENT_IDS].sort()).toEqual([...WORKFLOW_IDS].sort());
    expect([...SHARED_WORKFLOW_IDS]).toEqual([...WORKFLOW_IDS]);
    for (const w of Object.values(WORKFLOWS)) {
      expect(w.steps.length, w.id).toBeGreaterThanOrEqual(3);
      for (const id of w.steps) expect(STEPS.get(id), `${w.id}: step ${id}`).toBeDefined();
    }
  });

  it("names, for every step, capabilities that exist and are available, and limits that exist and are not", () => {
    const bad: string[] = [];
    for (const s of STEPS.values()) {
      const relied = [...s.needs, ...(s.any ?? []), ...(s.notes ?? []).flatMap((n) => n.needs), ...s.screen.flatMap((r) => r.when ?? [])];
      for (const id of relied) {
        if (!capability(id)) bad.push(`${s.id}: ${id} does not exist`);
        else if (!AVAILABLE(id)) bad.push(`${s.id}: relies on ${id}, which is not supported`);
      }
      for (const id of s.limits ?? []) {
        if (!capability(id)) bad.push(`${s.id}: limit ${id} does not exist`);
        else if (capability(id)!.status !== "unsupported") bad.push(`${s.id}: limit ${id} is not an unsupported capability`);
      }
      // A step names what it relies on in data: something, even if only through the ways it can be done.
      if (s.needs.length === 0 && !(s.any ?? []).length) bad.push(`${s.id}: relies on nothing`);
    }
    expect(bad).toEqual([]);
  });

  it("keeps every step id unique, in its workflows once, and every screen line to words that exist", () => {
    const ids = [...STEPS.keys()];
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of Object.values(WORKFLOWS)) expect(new Set(w.steps).size, w.id).toBe(w.steps.length);
    const used = new Set(Object.values(WORKFLOWS).flatMap((w) => w.steps));
    expect([...STEPS.keys()].filter((id) => !used.has(id))).toEqual([]);
    for (const s of STEPS.values()) {
      expect(s.screen.length, s.id).toBeGreaterThan(0);
      for (const r of s.screen) {
        expect(r.tokens.length, s.id).toBeGreaterThan(0);
        for (const tok of r.tokens) if (!isLiteral(tok) && !isMoney(tok)) expect(tok, s.id).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      }
    }
  });

  it("gives every business type's journeys the steps their capabilities need: the required ones are always there", () => {
    const missing: string[] = [];
    for (const type of BUSINESS_TYPES) {
      const listed = new Set(type.capabilities);
      for (const wid of type.workflows) {
        for (const id of WORKFLOWS[wid].steps) {
          const step = STEPS.get(id)!;
          if (!step.optional && !stepShown(step, listed)) missing.push(`${type.id} / ${wid}: ${id}`);
        }
        expect(shownSteps(wid, listed).length, `${type.id} / ${wid}`).toBeGreaterThanOrEqual(2);
      }
    }
    expect(missing).toEqual([]);
  });

  it("never claims, in a workflow, a capability the business type does not list", () => {
    for (const type of BUSINESS_TYPES) {
      const view = fitView({ types: [type.id], activities: [] });
      const listed = new Set(type.capabilities);
      for (const id of viewClaims(view)) expect(listed.has(id), `${type.id}: claims ${id}, which it does not list`).toBe(true);
      // The same holds of every capability a step's notes and screen lines name.
      for (const w of view.workflows) for (const s of w.steps) for (const n of s.notes) for (const id of n.needs) expect(listed.has(id), `${type.id}: note ${n.id} needs ${id}`).toBe(true);
    }
  });

  it("is in all four languages, every phrase the content uses, with the same placeholders", () => {
    const keys = contentPhraseKeys();
    expect(keys.length).toBeGreaterThan(400);
    const slots = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
    const bad: string[] = [];
    for (const key of keys) {
      for (const locale of LOCALES) {
        const text = DICTIONARIES[locale][key];
        if (!text || !text.trim()) bad.push(`${locale}: ${key} is missing`);
        else if (JSON.stringify(slots(text)) !== JSON.stringify(slots(DICTIONARIES.en[key]))) bad.push(`${locale}: ${key} has other placeholders`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("has every fit. phrase in four languages, and none the content does not use or the page does not name", () => {
    const all = (Object.keys(DICTIONARIES.en) as Phrase[]).filter((k) => k.startsWith("fit."));
    expect(all.length).toBeGreaterThan(500);
    for (const locale of LOCALES) {
      const keys = (Object.keys(DICTIONARIES[locale]) as Phrase[]).filter((k) => k.startsWith("fit."));
      expect(keys.sort(), locale).toEqual([...all].sort());
    }
    // Machine-assisted languages are not English left in: Chinese and Tamil use their own scripts, Malay differs from the English.
    for (const key of all) {
      const text = DICTIONARIES.en[key];
      if (text.split(/\s+/).length <= 3) continue;
      expect(DICTIONARIES.zh[key], key).toMatch(/[一-鿿]/);
      expect(DICTIONARIES.ta[key], key).toMatch(/[஀-௿]/);
      expect(DICTIONARIES.ms[key], key).not.toBe(text);
    }
    // Every dictionary phrase the content refers to is a real fit. one, so a typo shows here rather than as a key on a page.
    for (const key of contentPhraseKeys()) expect(key.startsWith("fit.")).toBe(true);
  });
});

describe("what a business type's page shows", () => {
  it("lists a chip for each of its capabilities as availabilityOf says, and the unsupported ones that go with them", () => {
    for (const type of BUSINESS_TYPES) {
      const view = fitView({ types: [type.id], activities: [] });
      const byId = new Map(view.listed.map((l) => [l.capability.id, l]));
      for (const id of type.capabilities) {
        const l = byId.get(id);
        expect(l, `${type.id}: ${id} has no chip`).toBeDefined();
        expect(l!.availability, `${type.id}: ${id}`).toBe(availabilityOf(capability(id)!));
      }
      for (const l of view.listed) expect(l.availability, `${type.id}: ${l.capability.id}`).toBe(availabilityOf(l.capability));
      // Every chip is in exactly one of the five groups.
      const grouped = Object.values(view.byAvailability).flat();
      expect(grouped.length).toBe(view.listed.length);
      // Anything it adds beyond the list is a limit that goes with it, never a claim.
      for (const l of view.listed) if (!type.capabilities.includes(l.capability.id)) expect(l.capability.status, `${type.id}: ${l.capability.id}`).toBe("unsupported");
    }
  });

  it("rests every listed available capability on a feature-status row that says it is implemented, naming its integration", () => {
    const bad: string[] = [];
    for (const type of BUSINESS_TYPES) {
      for (const l of fitView({ types: [type.id], activities: [] }).listed) {
        const c = l.capability;
        if (c.status !== "available") continue;
        const row = rows.get(c.featureRow ?? "");
        if (!row) bad.push(`${type.id}: ${c.id} has no row`);
        else if (row.status !== "IMPLEMENTED_AND_TESTED" && row.status !== "INTEGRATION_VERIFICATION_REQUIRED") bad.push(`${type.id}: ${c.id} is ${row.status}`);
        else if (row.status === "INTEGRATION_VERIFICATION_REQUIRED" && availabilityOf(c) !== "integration" && availabilityOf(c) !== "approval") bad.push(`${type.id}: ${c.id} needs a live check and is not labelled as needing an integration`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("says, for every unsupported capability it shows, what to do instead, and marks nothing unsupported as available", () => {
    for (const type of BUSINESS_TYPES) {
      const view = fitView({ types: [type.id], activities: [] });
      for (const c of view.limits.relevant) {
        const chip = presentCapability(en, c);
        expect(chip.alternative, `${type.id}: ${c.id}`).toBeTruthy();
        expect(chip.availability).toBe("unsupported");
      }
      expect(view.limits.relevant.length + view.limits.others.length).toBe(CAPABILITIES.filter((c) => c.status === "unsupported").length);
      expect(view.byAvailability.unsupported.map((l) => l.capability.id).sort()).toEqual(view.limits.relevant.map((c) => c.id).sort());
    }
  });

  it("shows the owner's cases as they are: gyms, climbing, bowling, swimming, equipment rental, Billplz, WhatsApp", () => {
    const view = (...types: string[]) => fitView({ types: types as never, activities: [] });
    const unsupported = (v: ReturnType<typeof fitView>) => v.limits.relevant.map((c) => c.id);

    // A gym: entry on a membership without booking a session is built (lib/entries.ts), listed as available; sessions too.
    const gym = view("gym-and-fitness");
    expect(unsupported(gym)).not.toContain("gym-walk-in");
    expect(gym.listed.find((l) => l.capability.id === "gym-walk-in")?.capability.status).toBe("available");
    expect(gym.workflows.map((w) => w.id)).toContain("timed-session");
    expect(gym.partial.map((a) => a.key)).not.toContain("gym");
    expect(activityFacts("gym")!.supportNote).toBeNull();

    // Climbing: day passes with no set time are built, beside sessions and a sign-off.
    const climbing = view("climbing-and-bouldering");
    expect(unsupported(climbing)).not.toContain("open-day-pass");
    expect(climbing.listed.find((l) => l.capability.id === "open-day-pass")?.capability.status).toBe("available");
    expect(climbing.workflows.map((w) => w.id)).toEqual(expect.arrayContaining(["timed-session", "first-visit-sign-off", "equipment-hire"]));

    // Bowling is sold by the game, the lane given on arrival: adding it lists that, as the catalogue says, and nothing short of full.
    const bowling = fitView({ types: [], activities: ["bowling"] });
    expect(unsupported(bowling)).not.toContain("bowling-by-game");
    expect(bowling.listed.find((l) => l.capability.id === "bowling-by-game")?.capability.status).toBe("available");
    expect(bowling.partial).toEqual([]);

    // Swimming is never left unstaffed, and its journeys never include unstaffed entry.
    const swimming = view("swimming");
    expect(swimming.workflows.map((w) => w.id)).not.toContain("unstaffed-entry");
    expect(workflowApplies("unstaffed-entry", [activityFacts("swimming"), activityFacts("kayak")])).toBe(false);
    expect(workflowApplies("unstaffed-entry", [activityFacts("swimming"), activityFacts("gym")])).toBe(true);

    // Equipment rental: hire with a deposit; the deposit is hand-over and return, and it is never unstaffed.
    const rental = view("equipment-rental");
    const hire = rental.workflows.find((w) => w.id === "equipment-hire")!;
    expect(hire.steps.map((s) => s.step.id)).toEqual(["eh-book", "eh-handover", "eh-return", "eh-kept"]);
    expect(rental.workflows.map((w) => w.id)).not.toContain("unstaffed-entry");

    // Billplz refunds are by hand, said wherever Billplz payments are; WhatsApp is from the platform's number, said where alerts are.
    expect(unsupported(view("badminton-and-pickleball"))).toEqual(expect.arrayContaining(["billplz-refunds", "venue-whatsapp-number"]));
    expect(en("gcap.billplz-refunds.alt")).toMatch(/by hand/i);
    expect(Object.keys(LIMITS_WITH).every((id) => AVAILABLE(id))).toBe(true);
    expect(Object.values(LIMITS_WITH).flat().every((id) => capability(id)?.status === "unsupported")).toBe(true);

    // An unstaffed gym names what is not there: smart locks and a door credential for each person.
    const mixed = view("gym-and-fitness");
    const unstaffed = mixed.workflows.find((w) => w.id === "unstaffed-entry")!;
    expect(unstaffed.steps.flatMap((s) => s.step.limits ?? [])).toEqual(["smart-locks", "door-credentials"]);
    expect(unsupported(mixed)).toEqual(expect.arrayContaining(["smart-locks", "door-credentials"]));
  });

  it("makes no claim a page could not back: no testimonial, saving or statistic in any phrase, and no figure but made-up sample ones", () => {
    const text = contentPhraseKeys()
      .map((k) => DICTIONARIES.en[k])
      .concat((Object.keys(DICTIONARIES.en) as Phrase[]).filter((k) => k.startsWith("fit.")).map((k) => DICTIONARIES.en[k]))
      .join("\n");
    for (const word of [/testimonial/i, /\bsavings?\b/i, /\bsave (you|money|time|up)\b/i, /\d+\s?%/, /guarantee/i, /best[- ]in/i, /trusted by/i, /\bfastest\b/i, /\bcheapest\b/i]) expect(text, String(word)).not.toMatch(word);
  });
});

describe("a selection of several kinds of business", () => {
  it("is composed, not forced into one: the union of their journeys, each with where it came from", () => {
    const view = fitView({ types: ["badminton-and-pickleball", "gym-and-fitness"], activities: [] });
    const composed = composeTypes(["badminton-and-pickleball", "gym-and-fitness"]);
    expect(view.combined).toBe(true);
    expect(view.types).toEqual(["badminton-and-pickleball", "gym-and-fitness"]);
    const ids = view.workflows.map((w) => w.id);
    for (const w of composed.workflows) expect(ids).toContain(w.id);
    expect(view.workflows.find((w) => w.id === "court-booking")!.from).toEqual(["badminton-and-pickleball"]);
    expect(view.workflows.find((w) => w.id === "membership-benefits")!.from).toEqual(["badminton-and-pickleball", "gym-and-fitness"]);
    // Its capabilities are the union, and the statements about running them together rest on capabilities it lists.
    expect(view.listed.map((l) => l.capability.id)).toEqual(expect.arrayContaining(composed.capabilities.map((c) => c.id)));
    expect(view.combinedClaims.length).toBeGreaterThan(0);
    for (const id of view.combinedClaims) {
      const claim = COMBINED_CLAIMS.find((c) => c.id === id)!;
      for (const need of claim.needs) expect(view.listed.some((l) => l.capability.id === need && l.capability.status === "available")).toBe(true);
    }
    // Both kinds' limits are shown; a gym's entry without a session is built (lib/entries.ts), so it is listed, not a limit.
    expect(view.limits.relevant.map((c) => c.id)).toContain("venue-whatsapp-number");
    expect(view.listed.map((l) => l.capability.id)).toContain("gym-walk-in");
  });

  it("treats the mixed venue and activities of several models as combined, and one ordinary type as not", () => {
    expect(fitView({ types: ["mixed"], activities: [] }).combined).toBe(true);
    expect(fitView({ types: [], activities: ["badminton", "yoga"] }).combined).toBe(true);
    expect(fitView({ types: ["badminton-and-pickleball"], activities: [] }).combined).toBe(false);
    expect(fitView({ types: [], activities: [] }).empty).toBe(true);
    expect(fitView({ types: [], activities: [] }).workflows).toEqual([]);
  });

  it("lets an activity refine the choice: its model brings its journeys and its limits, and a hire fleet is not unstaffed", () => {
    const kayak = fitView({ types: [], activities: ["kayak"] });
    expect(kayak.workflows.map((w) => w.id)).toContain("equipment-hire");
    expect(kayak.listed.map((l) => l.capability.id)).toContain("equipment-hire");
    expect(kayak.workflows.map((w) => w.id)).not.toContain("unstaffed-entry");
    const climb = fitView({ types: ["badminton-and-pickleball"], activities: ["climbing"] });
    expect(climb.workflows.map((w) => w.id)).toEqual(expect.arrayContaining(["court-booking", "timed-session", "first-visit-sign-off"]));
    // Climbing's own way of selling it (a day pass with no set time) comes with it, available (lib/entries.ts).
    expect(climb.listed.map((l) => l.capability.id)).toContain("open-day-pass");
    expect(climb.activities.find((a) => a.key === "climbing")!.from).toEqual(["activity"]);
    // What the models bring are real capabilities and journeys.
    for (const ids of Object.values(MODEL_CAPABILITIES)) for (const id of ids) expect(AVAILABLE(id), id).toBe(true);
    for (const ids of Object.values(MODEL_WORKFLOWS)) for (const id of ids) expect(WORKFLOW_IDS as readonly string[], id).toContain(id);
    // An activity chosen with the type that already has it is not added twice.
    const same = fitView({ types: ["swimming"], activities: ["swimming"] });
    expect(same.activities.filter((a) => a.key === "swimming").length).toBe(1);
  });

  it("claims, for activities alone, only what the registry says is available", () => {
    for (const key of BUILTIN_ACTIVITIES.map((a) => a.key)) {
      const view = fitView({ types: [], activities: [key] });
      expect(view.workflows.length, key).toBeGreaterThan(0);
      for (const id of viewClaims(view)) expect(AVAILABLE(id), `${key}: ${id}`).toBe(true);
      for (const w of view.workflows) expect(w.steps.length, `${key}: ${w.id}`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("the choice in the address", () => {
  it("reads types and activities, ignores what does not exist, and keeps the guide's own order", () => {
    expect(parseSelection({ types: "mixed,badminton-and-pickleball,bogus", activities: "yoga,badminton,curling" })).toEqual({
      types: ["badminton-and-pickleball", "mixed"],
      activities: ["badminton", "yoga"],
    });
    // A form's repeated boxes and a comma list mean the same.
    expect(parseSelection({ types: ["swimming", "mixed"] })).toEqual({ types: ["swimming", "mixed"], activities: [] });
    expect(parseSelection({ types: "", activities: undefined })).toEqual(emptySelection());
    expect(parseSelection({ types: "__proto__,constructor,toString" })).toEqual(emptySelection());
    expect(parseSelection({ types: Array.from({ length: 500 }, () => "swimming") }).types).toEqual(["swimming"]);
  });

  it("is carried to the application form as a short, readable address that comes back the same", () => {
    const sel = { types: ["badminton-and-pickleball", "gym-and-fitness"] as never, activities: ["yoga"] };
    expect(guideAddress(sel)).toBe("/for-venues?types=badminton-and-pickleball,gym-and-fitness&activities=yoga");
    expect(applyAddress(sel)).toBe("/list-your-venue?fit=types:badminton-and-pickleball,gym-and-fitness~activities:yoga");
    expect(applyAddress(emptySelection())).toBe("/list-your-venue");
    const fit = decodeFit(encodeFit(sel));
    expect(selectionOf(fit)).toEqual(sel);
    // What `submitApplication` takes: the GuideAnswers shape, valid.
    expect(normaliseFit(fit)).toEqual({ ok: true, fit: { v: 1, types: sel.types, activities: ["yoga"] } });
    for (const t of BUSINESS_TYPE_IDS) expect(applyAddress({ types: [t], activities: [] }).length).toBeLessThan(80);
  });

  it("reads a form address and JSON alike, drops what does not exist, and never throws", () => {
    expect(selectionOf(decodeFit("types:swimming,spaceport~activities:swimming,curling"))).toEqual({ types: ["swimming"], activities: ["swimming"] });
    expect(selectionOf(decodeFit('{"types":["swimming","nope"],"activities":["swimming"],"children":true}'))).toEqual({ types: ["swimming"], activities: ["swimming"] });
    expect(decodeFit('{"types":["swimming"],"children":true}')).toEqual({ v: 1, types: ["swimming"], children: true });
    for (const bad of [null, undefined, "", "   ", "{", "[1,2]", "types:", "types:nope", "x".repeat(2500), "{\"types\":\"swimming\"}", "~~~", "types:__proto__"]) expect(decodeFit(bad as never), String(bad)).toBeNull();
    expect(decodeFit("activities:yoga")).toEqual({ v: 1, activities: ["yoga"] });
  });
});

describe("the words on the page", () => {
  it("are said in every language with no phrase key showing, for every business type", () => {
    for (const locale of LOCALES) {
      const t = translator(locale);
      for (const type of BUSINESS_TYPES) {
        const view = fitView({ types: [type.id], activities: [] });
        const texts: string[] = [];
        for (const w of presentWorkflows(view, t)) {
          texts.push(w.title, w.intro);
          for (const s of w.steps) {
            texts.push(s.actor, s.title, s.sees, s.checks, ...s.notes, ...s.relies.map((r) => r.title), ...s.screen.lines.map((l) => l.text));
            for (const l of s.limits) texts.push(l.title, l.alternative);
          }
        }
        for (const l of view.listed) {
          const chip = presentChip(t, l);
          texts.push(chip.title, chip.blurb, chip.label, chip.needs ?? "", chip.alternative ?? "");
        }
        for (const text of texts) {
          expect(text, `${locale} / ${type.id}`).not.toMatch(/\bfit\.[a-z]/);
          expect(text, `${locale} / ${type.id}`).not.toMatch(/\bgcap\./);
          expect(text, `${locale} / ${type.id}`).not.toMatch(/\{[a-z]+\}/i);
        }
        expect(texts.filter((x) => x.trim() === "")).toEqual(texts.filter((x) => x === ""));
      }
    }
  });

  it("write an illustrative line as its words joined, an amount in the install's money and a literal as it is", () => {
    expect(tokenText(en, "#19:00–20:00")).toBe("19:00–20:00");
    expect(tokenText(en, "$40")).toMatch(/40$/);
    expect(tokenText(en, "$40")).toMatch(/^[^\d\s]+40$/);
    expect(tokenText(en, "court1")).toBe("Court 1");
    expect(tokenText(translator("ms"), "court1")).toBe("Gelanggang 1");
    const choose = STEPS.get("choose")!;
    expect(lineText(en, choose.screen[0])).toMatch(/^Court 1 · 19:00–20:00 · free · \D+40$/);
    const phone = STEPS.get("counter-start")!.screen[0];
    expect(lineText(en, phone)).toMatch(/^Phone number: /);
    for (const s of STEPS.values()) for (const tok of screenTokens(s.screen)) expect(DICTIONARIES.en[tokenKey(tok)], `${s.id}: ${tok}`).toBeTruthy();
    for (const s of STEPS.values()) {
      expect(DICTIONARIES.en[stepTitleKey(s.id)], s.id).toBeTruthy();
      expect(DICTIONARIES.en[stepSeesKey(s.id)], s.id).toBeTruthy();
      expect(DICTIONARIES.en[stepChecksKey(s.id)], s.id).toBeTruthy();
      expect(DICTIONARIES.en[actorKey(s.actor)]).toBeTruthy();
    }
  });

  it("make the three required journeys real: the customer's booking, the parent's registration, the venue cancelling", () => {
    const view = fitView({ types: ["badminton-and-pickleball"], activities: [] });
    const booking = view.workflows.find((w) => w.id === "court-booking")!;
    expect(booking.steps.map((s) => s.step.id)).toEqual(["choose", "price", "pay", "day-list", "attend", "cash-up", "reports"]);
    const parent = fitView({ types: ["swimming"], activities: [] }).workflows.find((w) => w.id === "guardian-child-booking")!;
    expect(parent.steps.map((s) => s.step.id)).toEqual(expect.arrayContaining(["gc-person", "gc-checks", "gc-book"]));
    expect(en(stepChecksKey("gc-person"))).toMatch(/declared, never as verified/);
    const academy = fitView({ types: ["coaching-academy"], activities: [] });
    expect(academy.workflows.map((w) => w.id)).not.toContain("equipment-hire");
    expect(academy.workflows.map((w) => w.id)).toEqual(expect.arrayContaining(["lesson-booking", "class-enrolment", "guardian-child-booking"]));
    expect(academy.workflows.find((w) => w.id === "guardian-child-booking")!.steps.map((s) => s.step.id)).toContain("gc-approval");
    const cancel = fitView({ types: ["multi-sport"], activities: [] }).workflows.find((w) => w.id === "cancellation-and-refund")!;
    expect(cancel.steps.map((s) => s.step.id)).toEqual(["cx-customer", "cx-settle", "cx-staff", "cx-venue"]);
    expect(en(stepChecksKey("cx-venue"))).toMatch(/never reported as refunded before it is/);
  });
});
