import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import ts from "typescript";

/**
 * Every field on the staff dashboard has a name a screen reader says and a
 * person can still read once they have typed (audit R8 X2-18): a visible
 * `<label>` around it or pointing at it (`htmlFor`), or, where the layout has
 * no room for one, `aria-label` / `aria-labelledby`. A placeholder is not a
 * name: it goes as soon as somebody types.
 *
 * Read from the source with the TypeScript parser, so a form nobody has opened
 * in a test is checked too. A field whose label is given by the component that
 * renders it (props spread onto it) is left to that component.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

/** Fields without an accessible name in one file: "File.tsx:123 <input>". */
export function unnamedFields(file: string): string[] {
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
      const named =
        inLabel ||
        attrs.has("aria-label") ||
        attrs.has("aria-labelledby") ||
        (attrs.has("id") && pointedAt.has(attrs.get("id")!)) ||
        ["hidden", "submit", "button", "reset"].includes(type ?? "") ||
        props.some(ts.isJsxSpreadAttribute);
      if (!named) bad.push(`${path.relative(ROOT, file)}:${src.getLineAndCharacterOfPosition(open.getStart()).line + 1} <${open.tagName.getText()}>`);
    }
    ts.forEachChild(n, (c) => visit(c, inLabel));
  };
  visit(src, false);
  return bad;
}

function tsxUnder(dir: string): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".tsx"))
    .map((e) => path.join(e.parentPath, e.name));
}

describe("form fields have accessible names", () => {
  it("finds a field labelled by its placeholder only, and accepts each way of naming one", () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "tests", ".tmp-labels-"));
    try {
      const file = path.join(dir, "Sample.tsx");
      fs.writeFileSync(
        file,
        `export function A() {
  return (
    <form>
      <input placeholder="Class name" />
      <label>Name <input /></label>
      <label htmlFor="when">Date</label>
      <input id="when" type="date" />
      <select aria-label="Venue"><option>1</option></select>
      <textarea placeholder="Description" />
      <input type="hidden" value="1" />
    </form>
  );
}
`
      );
      expect(unnamedFields(file).map((l) => l.replace(/^.*Sample\.tsx/, "Sample.tsx"))).toEqual(["Sample.tsx:4 <input>", "Sample.tsx:9 <textarea>"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the staff dashboard's components name every field", () => {
    const files = [...tsxUnder("src/components/admin"), ...tsxUnder("src/app/admin")];
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap(unnamedFields)).toEqual([]);
  });

  it("the customer's group form names every field", () => {
    expect(tsxUnder("src/app/games/groups").flatMap(unnamedFields)).toEqual([]);
  });
});
