import assert from "node:assert/strict";
import test from "node:test";
import { measureLineSurvival } from "../dist/survival.js";

test("exact-line prototype survives file moves and bounds duplicate attribution", () => {
  const before = ["Keep this.\nKeep this.\nRoot guidance.\n"];
  const after = ["Root guidance.\n", "Keep this.\nNew guidance.\n"];
  assert.deepEqual(measureLineSurvival(before, after), {
    method: "exact-nonblank-line-multiset-v1",
    originalLines: 3,
    survivingLines: 2,
    fraction: 2 / 3,
  });
  assert.equal(measureLineSurvival(["Use tabs.\r\n"], ["  Use tabs.\n"]).fraction, 1);
  assert.equal(measureLineSurvival(["Long instruction."], ["Long instruction, revised."]).fraction, 0);
  assert.equal(measureLineSurvival([" \n"], ["Anything"]).fraction, null);
});
