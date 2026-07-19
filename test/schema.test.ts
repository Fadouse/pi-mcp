import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMcpInputSchema, schemaSearchText } from "../src/schema.js";

test("normalizes local JSON Schema references", () => {
  const schema = normalizeMcpInputSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: {
      issue: { type: "string", description: "Issue identifier" },
    },
    properties: {
      issueId: { $ref: "#/$defs/issue" },
    },
    required: ["issueId"],
  }) as Record<string, unknown>;
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.$defs, undefined);
  assert.deepEqual((schema.properties as Record<string, unknown>).issueId, {
    type: "string",
    description: "Issue identifier",
  });
});

test("rejects external and recursive references", () => {
  assert.throws(
    () => normalizeMcpInputSchema({ type: "object", properties: { x: { $ref: "https://example.com/x" } } }),
    /external schema reference/,
  );
  assert.throws(
    () => normalizeMcpInputSchema({ type: "object", $defs: { node: { $ref: "#/$defs/node" } }, properties: { n: { $ref: "#/$defs/node" } } }),
    /recursive schema reference/,
  );
});

test("extracts property names and descriptions for discovery", () => {
  const text = schemaSearchText({
    type: "object",
    properties: { issueId: { type: "string", description: "GitHub issue number" } },
  });
  assert.match(text, /issueId/);
  assert.match(text, /GitHub issue number/);
});
