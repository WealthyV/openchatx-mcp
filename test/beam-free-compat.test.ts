import assert from "node:assert/strict"
import test from "node:test"

import { generateAgentTurn } from "../src/subagents/agent-provider.js"
import { subagentConfigSchema } from "../src/subagents/config.js"

function profile(provider: string) {
  return {
    provider,
    model: "test-model",
    name: "Test",
    description: "Fixture",
    enabled: true,
    context_window: 100_000,
    thinking: { mode: "none" as const },
  }
}

test("OpenCode Go Beam Free omits unsupported thinking fields and flattens root tool unions", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)) as Record<string, unknown>)
    return Response.json({ choices: [{ message: { content: "OK" } }] })
  }

  const config = subagentConfigSchema.parse({
    providers: {
      go: {
        type: "openai-compatible",
        base_url: "https://opencode.ai/inference/go/openai/v1",
      },
      other: {
        type: "openai-compatible",
        base_url: "https://api.example.com/v1",
      },
    },
    models: {
      beam: {
        ...profile("go"),
        model: "beam-free",
        thinking: {
          mode: "boolean",
          request_field: "enable_thinking",
          default_enabled: true,
        },
        extra_body: {
          enable_thinking: true,
          reasoning_effort: "high",
          thinking: { type: "enabled" },
        },
      },
      deepseek: {
        ...profile("go"),
        model: "deepseek-v4.1-flash",
        thinking: {
          mode: "effort",
          request_field: "reasoning_effort",
          levels: ["low", "high"],
          default: "high",
          default_enabled: true,
        },
      },
      unrelated: {
        ...profile("other"),
        model: "beam-free",
        thinking: {
          mode: "boolean",
          request_field: "enable_thinking",
          default_enabled: true,
        },
      },
    },
  })
  const go = config.providers.go
  const other = config.providers.other
  const beam = config.models.beam
  const deepseek = config.models.deepseek
  const unrelated = config.models.unrelated
  assert.ok(go && other && beam && deepseek && unrelated)
  assert.equal(go.type, "openai-compatible")
  assert.equal(other.type, "openai-compatible")
  if (go.type !== "openai-compatible" || other.type !== "openai-compatible")
    throw new Error("Invalid test provider")

  const unionSchema = {
    description: "Summarize content using one supported format.",
    properties: {
      payload: { $ref: "#/$defs/Payload" },
      legacy: { $ref: "#/definitions/LegacyPayload" },
    },
    $defs: { Payload: { type: "string" } },
    definitions: { LegacyPayload: { type: "number" } },
    allOf: [
      {
        oneOf: [
          {
            type: "object",
            title: "Text summary",
            properties: {
              mode: { type: "string", const: "text" },
              text: { type: "string" },
            },
            required: ["mode", "text"],
            additionalProperties: false,
          },
          {
            type: "object",
            title: "Structured summary",
            properties: {
              mode: { type: "string", const: "structured" },
              format: { type: "string", enum: ["json", "yaml"] },
            },
            required: ["mode", "format"],
            additionalProperties: false,
          },
        ],
      },
      {
        type: "object",
        properties: { agent_id: { type: "string", format: "uuid" } },
        required: ["agent_id"],
      },
    ],
  }
  const common = {
    messages: [{ role: "user" as const, content: "Summarize this." }],
    tools: [{ name: "summarize", description: "Summarize content", parameters: unionSchema }],
  }

  await generateAgentTurn({
    ...common,
    provider: go,
    providerId: "go",
    profile: beam,
    sessionId: "beam-session",
  })
  await generateAgentTurn({
    ...common,
    provider: go,
    providerId: "go",
    profile: deepseek,
    sessionId: "deepseek-session",
  })
  await generateAgentTurn({
    ...common,
    provider: other,
    providerId: "other",
    profile: unrelated,
  })

  const beamBody = requests[0]
  assert.ok(beamBody)
  assert.equal("enable_thinking" in beamBody, false)
  assert.equal("reasoning_effort" in beamBody, false)
  assert.equal("thinking" in beamBody, false)
  const beamTools = beamBody.tools as Array<{ function: { parameters: Record<string, unknown> } }>
  const beamParameters = beamTools[0]?.function.parameters
  assert.ok(beamParameters)
  assert.equal(beamParameters.type, "object")
  for (const unsupported of ["oneOf", "anyOf", "allOf", "enum", "const", "not"])
    assert.equal(unsupported in beamParameters, false)
  assert.deepEqual(beamParameters.required, ["mode", "agent_id"])
  assert.equal(beamParameters.additionalProperties, false)
  const properties = beamParameters.properties as Record<string, unknown>
  assert.ok(properties.mode && typeof properties.mode === "object")
  assert.ok(Array.isArray((properties.mode as Record<string, unknown>).anyOf))
  assert.ok(properties.text && properties.format && properties.agent_id)
  assert.deepEqual(beamParameters.$defs, { Payload: { type: "string" } })
  assert.deepEqual(beamParameters.definitions, { LegacyPayload: { type: "number" } })
  assert.deepEqual(properties.payload, { $ref: "#/$defs/Payload" })
  assert.deepEqual(properties.legacy, { $ref: "#/definitions/LegacyPayload" })

  const deepseekBody = requests[1]
  assert.ok(deepseekBody)
  assert.equal(deepseekBody.reasoning_effort, "high")
  const deepseekTools = deepseekBody.tools as Array<{
    function: { parameters: Record<string, unknown> }
  }>
  assert.equal("allOf" in (deepseekTools[0]?.function.parameters ?? {}), true)

  const unrelatedBody = requests[2]
  assert.ok(unrelatedBody)
  assert.equal(unrelatedBody.enable_thinking, true)
  const unrelatedTools = unrelatedBody.tools as Array<{
    function: { parameters: Record<string, unknown> }
  }>
  assert.equal("allOf" in (unrelatedTools[0]?.function.parameters ?? {}), true)
})
