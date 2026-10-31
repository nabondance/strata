import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { getEncoding } from "js-tiktoken";
import { createMeasurer } from "../dist/measurement.js";

const samples = [
  "",
  " ",
  "\n",
  "Plain instructions. Follow the project's conventions; don't skip tests, and we'll review it.",
  "trailing spaces   ",
  "   leading spaces",
  "tabs\tand\r\nwindows line endings\r\n\r\nand a blank line",
  "a  b   c    d     e      f",
  `| Column | Value |\n| --- | --- |\n| padded${" ".repeat(300)}| cell${" ".repeat(301)}|\n`,
  `${"-".repeat(400)}\n${"=".repeat(257)}\n${"ab".repeat(200)}`,
  "Accents: café, naïve, Zürich. CJK: 日本語のテキスト、中文文本。 Emoji: 👩‍💻🚀 ✅",
  "Special-token text is ordinary text here: <|endoftext|> and <|fim_prefix|>.",
  "const x = { a: [1, 2, 3], b: `template $(value)` }; // code\n\tif (x?.a) { return 0x1F; }",
  `https://example.com/a/very/long/path?with=query&and=${"0123456789abcdef".repeat(20)}`,
  "1234567890 3.14159 1,000,000 2026-10-09T12:34:56Z",
];

test("cached per-piece counting equals whole-text encoding", () => {
  for (const [mode, encoding] of [["openai-o200k_base", "o200k_base"]]) {
    const reference = getEncoding(encoding);
    const measurer = createMeasurer(mode);
    // Twice: once filling the cache, once reading from it. Then all samples as one document.
    for (const text of [...samples, ...samples, samples.join("\n"), samples.toReversed().join("  ")]) {
      assert.equal(
        measurer.count(Buffer.from(text)),
        reference.encode(text, [], []).length,
        `${encoding}: ${JSON.stringify(text.slice(0, 60))}`,
      );
    }
  }
});

test("repeated long runs are counted once, not once per file version", () => {
  const measurer = createMeasurer("openai-o200k_base");
  const version = (index) => Buffer.from(`# Version ${index}\n${(`| cell${" ".repeat(1000)}|\n`).repeat(40)}`);
  const started = performance.now();
  const first = measurer.count(version(0));
  const cold = performance.now() - started;
  const again = performance.now();
  for (let index = 1; index <= 20; index += 1) assert.equal(measurer.count(version(index)), first);
  const warm = (performance.now() - again) / 20;
  assert.ok(warm < cold / 5, `cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms per version`);
});

test("text that is not valid UTF-8 is rejected rather than counted", () => {
  assert.throws(() => createMeasurer("openai-o200k_base").count(Buffer.from([0xff])), /encoded data was not valid/);
});

test("only the estimate and o200k_base are supported", () => {
  assert.throws(() => createMeasurer("openai-cl100k_base"), /Unsupported tokenizer mode/);
});
