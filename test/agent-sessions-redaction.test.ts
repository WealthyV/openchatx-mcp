import assert from "node:assert/strict"
import test from "node:test"

import { safeToolArguments } from "../src/subagents/agent-sessions.js"

// Fictional test secret. It matches the real OpenAI key shape (sk- + 12+ chars)
// so the same code path is exercised; it is never a real credential.
const SECRET = "sk-1234567890abcdef"

test("safeToolArguments redacts secret values under non-sensitive field names", () => {
  // Regression: string values used to be returned verbatim unless the FIELD
  // NAME matched SECRET_KEY_RE, so a secret under data/query/url leaked in the
  // dashboard tool-argument preview.
  assert.equal(safeToolArguments({ data: SECRET }), JSON.stringify({ data: "[REDACTED]" }))
  assert.equal(
    safeToolArguments({ query: `token=${SECRET}` }),
    JSON.stringify({ query: "token=[REDACTED]" })
  )
  assert.equal(
    safeToolArguments({ url: `https://api.example.com/v1?api_key=${SECRET}` }),
    JSON.stringify({ url: "https://api.example.com/v1?api_key=[REDACTED]" })
  )
})

test("safeToolArguments still redacts by sensitive field name", () => {
  assert.equal(
    safeToolArguments({ authorization: `Bearer ${SECRET}` }),
    JSON.stringify({ authorization: "[redacted]" })
  )
})

test("safeToolArguments redacts secrets nested in JSON-string values", () => {
  const out = JSON.parse(safeToolArguments({ payload: JSON.stringify({ token: SECRET }) }))
  assert.equal(JSON.parse(out.payload).token, "[redacted]")
})

test("safeToolArguments does not mangle ordinary non-secret values", () => {
  assert.equal(
    safeToolArguments({ path: "/tmp/work/notes.txt" }),
    JSON.stringify({ path: "/tmp/work/notes.txt" })
  )
})
