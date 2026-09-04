import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeProjection } from "../src/index.ts";

test("consumes a bounded workflow projection through the public library surface", () => {
  assert.deepEqual(consumeProjection('{"phase":"draft"}'), { phase: "draft" });
});
