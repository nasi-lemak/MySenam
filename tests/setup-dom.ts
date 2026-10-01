/**
 * Cleanup between component tests.
 *
 * Testing Library mounts into a container it leaves behind, so without this a
 * second test in the same file finds two copies of everything and `getByText`
 * throws on the ambiguity. Harmless in the node-environment tests, which have
 * no document to clean.
 */
import { afterEach } from "vitest";

afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
