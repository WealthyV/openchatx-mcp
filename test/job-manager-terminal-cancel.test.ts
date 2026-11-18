import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { JobManager, type JobStatus } from "../src/jobs/job-manager.js"

async function withJob<T>(
  text: string | Uint8Array,
  run: (jobs: JobManager, logPath: string, root: string) => Promise<T>,
  status: JobStatus = "completed"
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "openchatx-terminal-cancel-test-"))
  const logPath = join(root, "job.log")
  const statePath = join(root, "jobs.json")
  const now = new Date().toISOString()
  await writeFile(logPath, text)
  const states = ["completed", "failed", "interrupted", "cancelled"] as const
  const jobs = [
    {
      id: "log",
      status,
      label: "Synthetic log",
      command: "true",
      cwd: root,
      pid: status === "running" ? process.pid : 999999,
      createdAt: now,
      updatedAt: now,
      logPath,
    },
    ...states.map((terminalStatus) => ({
      id: terminalStatus,
      status: terminalStatus,
      label: "Synthetic terminal",
      command: "true",
      cwd: root,
      pid: 999999,
      createdAt: now,
      updatedAt: now,
      logPath,
      ...(terminalStatus === "completed" ? { exitCode: 0 } : {}),
    })),
  ]
  await writeFile(statePath, JSON.stringify({ jobs }))
  const manager = new JobManager(root, statePath)
  try {
    return await run(manager, logPath, root)
  } finally {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
}

test("cancel: cancel preserves each terminal status, exitCode, timestamps and persisted state", async () => {
  await withJob("done", async (jobs, _log, root) => {
    const stateFile = join(root, "jobs.json")
    for (const status of ["completed", "failed", "interrupted", "cancelled"] as const) {
      const original = await jobs.get(status)
      const beforeOnDisk = await readFile(stateFile, "utf8")
      const returned = await jobs.cancel(status)
      const repeated = await jobs.cancel(status)
      const actual = await jobs.get(status)
      assert.deepEqual(returned, original, `First cancel must not mutate terminal job ${status}`)
      assert.deepEqual(repeated, original, `Repeated cancel is idempotent for ${status}`)
      assert.deepEqual(actual, original, `Terminal state must be unchanged for ${status}`)
      assert.equal(
        await readFile(stateFile, "utf8"),
        beforeOnDisk,
        `No disk rewrite for terminal ${status}`
      )
    }
    await assert.rejects(jobs.cancel("unknown"), /Unknown durable job/)
  })
})

test("cancel: cancelling a naturally completed child never overwrites the actual exit result", {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-terminal-cancel-process-"))
  const manager = new JobManager(root, join(root, "jobs.json"))
  try {
    const started = await manager.start("Synthetic completion", "exit 0", root)
    let finished = await manager.get(started.id)
    const deadline = Date.now() + 5000
    while (finished.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      finished = await manager.get(started.id)
    }
    assert.equal(finished.status, "completed", "Synthetic child must finish before cancel")
    assert.equal(finished.exitCode, 0)
    const cancelled = await manager.cancel(started.id)
    assert.deepEqual(cancelled, finished)
    assert.deepEqual(await manager.get(started.id), finished)
  } finally {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("cancel: terminal cancel waits for a pending durable-state write before acknowledging", async () => {
  await withJob("done", async (jobs, _log, root) => {
    const statePath = join(root, "jobs.json")
    await jobs.get("completed") // Load the persisted fixture before simulating settlement.
    const internal = jobs as unknown as {
      jobs: Map<string, { status: string; updatedAt: string }>
      persistChain: Promise<void>
      persist: () => Promise<void>
    }
    const terminal = internal.jobs.get("completed")
    assert.ok(terminal)
    terminal.status = "failed"
    terminal.updatedAt = new Date().toISOString()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    internal.persistChain = gate
    const persistence = internal.persist() // Real JobManager atomic writer, queued behind a controlled gate.
    let acknowledged = false
    const pendingCancel = jobs.cancel("completed").then((job) => {
      acknowledged = true
      return job
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(acknowledged, false, "The terminal status is not yet durable")
      const disk = JSON.parse(await readFile(statePath, "utf8")) as {
        jobs: Array<{ id: string; status: string }>
      }
      assert.equal(disk.jobs.find((job) => job.id === "completed")?.status, "completed")
    } finally {
      release()
    }
    await persistence
    const result = await pendingCancel
    assert.equal(result.status, "failed")
    const disk = JSON.parse(await readFile(statePath, "utf8")) as {
      jobs: Array<{ id: string; status: string }>
    }
    assert.equal(disk.jobs.find((job) => job.id === "completed")?.status, "failed")
  })
})
