import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../../src/config.ts";
import { validConfig } from "../fixtures/config.ts";

test("parseConfig accepts an exact valid configuration", () => {
  assert.deepEqual(parseConfig(validConfig()), validConfig());
});

test("parseConfig fails closed on versions, unknown fields, duplicates, and bad thinking", () => {
  assert.throws(() => parseConfig({ ...validConfig(), schemaVersion: 2 }), /Unsupported/);
  assert.throws(() => parseConfig({ ...validConfig(), surprise: true }), /unknown fields/);
  const duplicate = validConfig();
  duplicate.nucleusPolicy.allowedModels.push({ ...duplicate.nucleusPolicy.allowedModels[0]! });
  assert.throws(() => parseConfig(duplicate), /duplicate/);
  const thinking = validConfig() as unknown as Record<string, any>;
  thinking.nucleusPolicy.minimumThinking = "low";
  assert.throws(() => parseConfig(thinking), /medium, high, or xhigh/);
});

test("parseConfig separates every faculty tuple from Nucleus and bounds timeout", () => {
  const overlap = validConfig();
  overlap.faculties.hand = { provider: "primary", model: "high", thinking: "medium", timeoutMs: 1000 };
  assert.throws(() => parseConfig(overlap), /may not reuse/);
  const timeout = validConfig();
  timeout.faculties.eye.timeoutMs = 999;
  assert.throws(() => parseConfig(timeout), /1000/);
});

test("parseConfig rejects whitespace and implicit fallback fields", () => {
  const whitespace = validConfig();
  whitespace.faculties.eye.model = " eye";
  assert.throws(() => parseConfig(whitespace), /exact nonempty/);
  const fallback = structuredClone(validConfig()) as Record<string, any>;
  fallback.faculties.eye.fallbackModels = ["other"];
  assert.throws(() => parseConfig(fallback), /unknown fields/);
});
