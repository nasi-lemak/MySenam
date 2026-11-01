import type { T } from "@/lib/i18n";

/**
 * Using MySenam from an AI assistant, said briefly at the foot of the public
 * guide (docs/integrations/mcp.md#connecting): the MCP server's address, that
 * its public tools need no key, and that a venue's own tools take the venue's
 * API key, kept in an environment variable. Server-rendered; writes nothing.
 */
export default function AiAssistants({ t, url }: { t: T; url: string }) {
  return (
    <section id="ai" aria-labelledby="ai-h" className="scroll-mt-20 rounded-2xl border border-slate-200 bg-white p-5">
      <h2 id="ai-h" className="text-xl font-bold text-slate-900">
        {t("mcp.title")}
      </h2>
      <p className="mt-1 text-slate-700">{t("mcp.body", { url })}</p>
      <p className="mt-2 text-slate-700">{t("mcp.venue")}</p>
      <p className="mt-2 text-sm text-slate-600">{t("mcp.example")}</p>
      {/* A command as typed, the same in every language. */}
      <pre className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 text-xs">
        <code>{`claude mcp add --transport http mysenam ${url}`}</code>
      </pre>
    </section>
  );
}
