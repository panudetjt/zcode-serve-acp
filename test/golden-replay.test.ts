/**
 * Golden replay — the parity gate for the rewrite.
 *
 * Replays the raw conversation frames captured from a real daemon
 * (test/fixtures/golden-frames/) through the CURRENT FrameTranslator and
 * compares its per-frame output with the pre-rewrite translator's recorded
 * output (the oracle). Any intentional behavior change must be justified and
 * the fixture re-captured — never hand-edit a fixture (see AGENTS.md).
 */
import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { FrameTranslator } from "../src/translate/translator.ts";

const FIXTURES_DIR = path.resolve(import.meta.dir, "fixtures/golden-frames");

interface RecordedFrame {
  payload: unknown;
  oracle: Record<string, unknown>;
}
interface ScenarioFixture {
  fixtureVersion: number;
  scenario: string;
  prompt: string;
  daemonRuntime: string;
  frames: RecordedFrame[];
  lifecycle: unknown[];
  terminalReason: string;
}

const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

describe("golden replay (pre-rewrite translator parity)", () => {
  it("has captured fixtures", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  for (const file of fixtureFiles) {
    it(`replays ${file} identically to the pre-rewrite translator`, async () => {
      const fixture = JSON.parse(await Bun.file(path.join(FIXTURES_DIR, file)).text()) as ScenarioFixture;
      const translator = new FrameTranslator(() => {});
      translator.startTurn();

      for (let i = 0; i < fixture.frames.length; i++) {
        const { payload, oracle } = fixture.frames[i]!;
        const actual = translator.fold(payload);
        const expected = oracle as Record<string, unknown>;
        // Compare field by field so failures pinpoint the diverging field.
        const actualRec = actual as unknown as Record<string, unknown>;
        for (const key of Object.keys(expected)) {
          expect(actualRec[key]).toEqual(expected[key]);
        }
        // The new fold must not invent keys the oracle lacks.
        for (const key of Object.keys(actualRec)) {
          expect(expected[key]).not.toBeUndefined();
        }
      }
      expect(fixture.terminalReason).not.toBe("timeout");
    });
  }
});
