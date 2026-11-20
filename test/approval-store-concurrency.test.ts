import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ApprovalStore } from "../src/runtime/approval-store.js"

async function withStorePath(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openchatx-approval-concurrency-"))
  try {
    await run(join(dir, "approvals.json"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("concurrent requests preserve every independent approval", async () =>
  withStorePath(async (path) => {
    const store = new ApprovalStore(path)
    const count = 25
    const approvals = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        store.request({
          toolName: "synthetic-tool",
          category: "test",
          reason: "synthetic",
          sessionId: "synthetic-session",
          argumentsValue: { index },
        })
      )
    )
    assert.equal(new Set(approvals.map((entry) => entry.id)).size, count)
    const state = JSON.parse(await readFile(path, "utf8")) as { approvals: unknown[] }
    assert.equal(state.approvals.length, count)
  }))

test("concurrent store instances sharing a path do not lose updates", async () =>
  withStorePath(async (path) => {
    const first = new ApprovalStore(path)
    const second = new ApprovalStore(path)
    const count = 30
    const approvals = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        (index % 2 ? first : second).request({
          toolName: "synthetic-tool",
          category: "test",
          reason: "synthetic",
          argumentsValue: { index },
        })
      )
    )
    assert.equal(new Set(approvals.map((entry) => entry.id)).size, count)
    const state = JSON.parse(await readFile(path, "utf8")) as { approvals: unknown[] }
    assert.equal(state.approvals.length, count)
  }))

test("concurrent identical requests reuse one pending approval", async () =>
  withStorePath(async (path) => {
    const first = new ApprovalStore(path)
    const second = new ApprovalStore(path)
    const approvals = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        (index % 2 ? first : second).request({
          toolName: "synthetic-tool",
          category: "test",
          reason: "synthetic",
          sessionId: "synthetic-session",
          argumentsValue: { shared: true },
        })
      )
    )
    assert.equal(new Set(approvals.map((entry) => entry.id)).size, 1)
    const state = JSON.parse(await readFile(path, "utf8")) as { approvals: unknown[] }
    assert.equal(state.approvals.length, 1)
  }))
