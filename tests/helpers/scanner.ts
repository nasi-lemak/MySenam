import type { DocumentScanner, ScannerStatus, ScanVerdict } from "../../src/lib/document-scanner";

/**
 * Stand-ins for the malware scanner (lib/document-scanner.ts), for tests of
 * everything around it: each answers as told and counts what it was asked.
 * The real engine is exercised in tests/document-scanning-engine.test.ts.
 */
export interface FakeScanner extends DocumentScanner {
  calls: number;
  /** What the next scans answer; a function sees the bytes. */
  answer: ScanVerdict | ((content: Buffer) => ScanVerdict | Promise<ScanVerdict>);
  state: ScannerStatus;
}

export function fakeScanner(answer: FakeScanner["answer"] = { kind: "clean", engine: "FakeScan 1.0/1/Mon Oct 26 06:00:00 2026" }): FakeScanner {
  const scanner: FakeScanner = {
    name: "fake",
    calls: 0,
    answer,
    state: { reachable: true, engine: "FakeScan 1.0/1/Mon Oct 26 06:00:00 2026", signaturesAt: new Date().toISOString(), error: null },
    async scan(content: Buffer) {
      scanner.calls++;
      return typeof scanner.answer === "function" ? scanner.answer(content) : scanner.answer;
    },
    async status() {
      return scanner.state;
    },
  };
  return scanner;
}

/** A scanner that passes everything: for tests about what happens once a document is released. */
export const passingScanner = () => fakeScanner();
