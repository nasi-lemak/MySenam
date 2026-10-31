import type { ScreenLine } from "@/lib/guide/public/present";

/**
 * A small made-up screen: what the step looks like, with sample data that is
 * labelled as such and never a real venue's (docs/features/venue-guide.md#the-public-guide).
 * Static markup, no script: it is the same before and after the page loads.
 *
 * Status is never the colour alone: every line says its state in words, and
 * the mark beside it (a tick, an ellipsis, a cross) repeats it for those who
 * read shapes before colours. The marks are decoration, so they are hidden
 * from a screen reader, which reads the words.
 */

const MARK: Record<ScreenLine["tone"], string> = { plain: "", ok: "✓", wait: "…", stop: "✕" };
const TONE: Record<ScreenLine["tone"], string> = {
  plain: "border-slate-200 bg-white text-slate-700",
  ok: "border-teal-200 bg-teal-50 text-teal-900",
  wait: "border-amber-200 bg-amber-50 text-amber-900",
  stop: "border-slate-300 bg-slate-100 text-slate-700",
};

export default function IllustrativeScreen({ title, lines, note, label }: { title: string; lines: ScreenLine[]; note: string; label: string }) {
  return (
    <figure aria-label={label} className="m-0 overflow-hidden rounded-xl border border-slate-300 bg-slate-50 shadow-sm">
      <figcaption className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-200 bg-white px-3 py-2 text-xs">
        <span className="font-semibold text-slate-800">{title}</span>
        <span className="rounded-full border border-slate-300 px-2 py-0.5 text-slate-600">{note}</span>
      </figcaption>
      <ul className="m-0 list-none space-y-1.5 p-3">
        {lines.map((line, i) => {
          if (line.as === "action")
            return (
              <li key={i}>
                {/* A picture of a button, not a control: it does nothing and is not in the tab order. */}
                <span className="inline-flex min-h-9 items-center rounded-lg bg-teal-700 px-3 text-sm font-semibold text-white" role="img" aria-label={line.text}>
                  <span aria-hidden>{line.text}</span>
                </span>
              </li>
            );
          if (line.as === "total")
            return (
              <li key={i} className="flex items-center justify-between rounded-lg border-t-2 border-slate-400 px-2 py-1.5 text-sm font-bold text-slate-900">
                {line.text}
              </li>
            );
          return (
            <li key={i} className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-sm ${line.as === "field" ? "border-dashed border-slate-300 bg-white text-slate-700" : TONE[line.tone]}`}>
              {MARK[line.tone] && (
                <span aria-hidden className="mt-px w-4 shrink-0 text-center font-bold">
                  {MARK[line.tone]}
                </span>
              )}
              <span className="min-w-0 break-words">{line.text}</span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
