/**
 * Golden replay — the parity gate for the rewrite.
 *
 * Replays the raw conversation frames captured from a real daemon
 * (test/fixtures/golden-frames/) through the CURRENT FrameTranslator and
 * compares its per-frame output with the recorded oracle. Any intentional
 * behavior change must be justified and the fixture re-captured — never
 * hand-edit a fixture (see AGENTS.md).
 *
 * Oracle provenance differs per fixture (see scripts/capture-frames.ts): the
 * three original fixtures (plain-text, tool-exec, question) record the
 * PRE-rewrite translator's output — true parity frames. The subagent fixture
 * (20 พ.ย. 2026) pins CURRENT behavior: its parent frames record `fold()`
 * output, and its interleaved `kind: "child"` frames record `foldChild()`
 * updates for the child-session drill-down, which has no pre-rewrite
 * equivalent. Comparison is deep-equality either way, so any translator
 * change that alters output still fails here.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { FrameTranslator } from "../src/translate/translator.ts";

const FIXTURES_DIR = path.resolve(import.meta.dir, "fixtures/golden-frames");

interface RecordedFrame {
  kind?: "child";
  childSessionId?: string;
  payload: unknown;
  oracle: Record<string, unknown> | Array<Record<string, unknown>>;
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

describe("golden replay (recorded oracle)", () => {
  it("has captured fixtures", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  for (const file of fixtureFiles) {
    it(`replays ${file} identically to the recorded oracle`, async () => {
      const fixture = JSON.parse(await Bun.file(path.join(FIXTURES_DIR, file)).text()) as ScenarioFixture;
      const translator = new FrameTranslator(() => {});
      translator.startTurn();

      for (let i = 0; i < fixture.frames.length; i++) {
        const frame = fixture.frames[i]!;
        if (frame.kind === "child") {
          // Child frame — compare foldChild's updates, in interleaved order so
          // the parent-frame binding (subagent row → childSessionId) reproduces
          // exactly as it happened live.
          const actualUpdates = translator.foldChild(frame.childSessionId!, frame.payload).updates;
          const expected = frame.oracle as Array<Record<string, unknown>>;
          expect(actualUpdates).toHaveLength(expected.length);
          for (let j = 0; j < expected.length; j++) {
            expect(actualUpdates[j] as unknown).toEqual(expected[j]);
          }
          continue;
        }
        const { payload, oracle } = frame as { payload: unknown; oracle: Record<string, unknown> };
        const actual = translator.fold(payload);
        // Compare field by field so failures pinpoint the diverging field.
        const actualRec = actual as unknown as Record<string, unknown>;
        for (const key of Object.keys(oracle)) {
          expect(actualRec[key]).toEqual(oracle[key]);
        }
        // The new fold must not invent keys the oracle lacks.
        for (const key of Object.keys(actualRec)) {
          expect(oracle[key]).not.toBeUndefined();
        }
      }
      expect(fixture.terminalReason).not.toBe("timeout");
      // The subagent fixture exists to pin the child-session drill-down — it
      // must contain child frames or the replay above passes vacuously (this
      // catches a recapture whose prompt let the child settle before the
      // subscribeChild round-trip completed).
      if (fixture.scenario === "subagent") {
        expect(fixture.frames.some((f) => f.kind === "child")).toBe(true);
      }
    });
  }
});
