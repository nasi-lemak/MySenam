/**
 * Startup: the scheduler, and checks.
 *
 * Next calls this once per server process, before the first request, which
 * makes it the right place to start the nightly backup and the outbox, and to
 * say out loud that a deployment is still holding its factory settings — the
 * kind of thing nobody notices until it is being exploited.
 *
 * This module is compiled for every runtime, including the edge one, where
 * the database drivers cannot be resolved. Everything that needs them is in
 * src/instrumentation-node.ts, imported inside a test of NEXT_RUNTIME written
 * the way the compiler can see through: an `if` around the import, which it
 * drops from the edge build. An early `return` before the import was not
 * seen through, and `next dev` failed on every page trying to bundle pg for
 * the edge.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startNode } = await import("./instrumentation-node");
    await startNode();
  }
}

/**
 * Any request that ends in a server error: filed with its stack under its
 * kind (lib/error-log.ts), and the platform owner told about each new kind,
 * so a page failing for every customer is not found out from a complaint.
 */
export async function onRequestError(err: unknown, request: { path: string; method: string }): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { noteRequestError } = await import("./lib/alerts");
    await noteRequestError(err, request);
  }
}
