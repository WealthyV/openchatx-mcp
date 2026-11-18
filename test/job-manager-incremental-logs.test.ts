import assert from "node:assert/strict"
import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { JobManager, type JobStatus } from "../src/jobs/job-manager.js"

async function withJob<T>(
  text: string | Uint8Array,
  run: (jobs: JobManager, logPath: string, root: string) => Promise<T>,
  status: JobStatus = "completed"
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "openchatx-log-read-test-"))
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

test("readLogFrom: ASCII a large log is fully retrievable without skipping its prefix", async () => {
  const payload = `BEGIN=${"A".repeat(16000)}=END`
  await withJob(payload, async (jobs) => {
    let cursor = 0
    let output = ""
    for (let i = 0; i < 30 && cursor < payload.length; i++) {
      const part = await jobs.readLogFrom("log", cursor, 1024)
      output += part.output
      assert.ok(part.nextCursor > cursor)
      cursor = part.nextCursor
    }
    assert.equal(cursor, payload.length)
    assert.equal(output, payload)
  })
})

test("readLogFrom: UTF-8 16-KiB response boundary never corrupts a multibyte symbol", async () => {
  const payload = `${"A".repeat(16383)}😀€漢字END`
  await withJob(payload, async (jobs) => {
    const first = await jobs.readLogFrom("log", 0, 16384)
    assert.ok(first.nextCursor > 0)
    assert.ok(first.nextCursor <= Buffer.byteLength(payload))
    assert.ok(Buffer.byteLength(first.output) <= 16384, "Normal calls must respect maxBytes")
    assert.equal(first.truncated, true)
    let total = first.output
    let cursor = first.nextCursor
    let lastTruncated: boolean = first.truncated
    for (let i = 0; i < 12 && cursor < Buffer.byteLength(payload); i++) {
      const part = await jobs.readLogFrom("log", cursor, 16384)
      assert.ok(part.nextCursor > cursor)
      total += part.output
      cursor = part.nextCursor
      lastTruncated = part.truncated
    }
    assert.equal(total, payload)
    assert.equal(cursor, Buffer.byteLength(payload))
    assert.equal(lastTruncated, false)
  })
})

test("readLogFrom: UTF-8 a 1-byte limit makes progress across 2/3/4-byte codepoints", async () => {
  const payload = "😀€é漢★Z"
  await withJob(payload, async (jobs) => {
    let cursor = 0
    let result = ""
    const sizes: number[] = []
    for (let i = 0; i < 20 && cursor < Buffer.byteLength(payload); i++) {
      const part = await jobs.readLogFrom("log", cursor, 1)
      assert.ok(part.nextCursor > cursor, "No stalling on Unicode")
      sizes.push(part.nextCursor - cursor)
      result += part.output
      cursor = part.nextCursor
    }
    assert.equal(result, payload)
    assert.deepEqual(sizes, [4, 3, 2, 3, 3, 1])
  })
})

test("readLogFrom: UTF-8 all small read limits preserve a mixed-language log exactly", async () => {
  const payload = `${"😀€é漢★Z".repeat(18) + "A".repeat(95)}\nконец`
  await withJob(payload, async (jobs) => {
    for (const limit of [1, 2, 3, 4, 5, 7, 11, 17, 31, 64, 127, 1024]) {
      let cursor = 0
      let assembled = ""
      const bytes = Buffer.byteLength(payload)
      for (let iteration = 0; cursor < bytes && iteration < 500; iteration++) {
        const part = await jobs.readLogFrom("log", cursor, limit)
        assert.ok(part.nextCursor > cursor, `Stalled on maxBytes=${limit} at cursor=${cursor}`)
        assert.ok(
          part.nextCursor - cursor <= Math.max(limit, 4),
          `Exceeded the maximum of one UTF-8 character at maxBytes=${limit}`
        )
        assembled += part.output
        cursor = part.nextCursor
        assert.equal(part.truncated, cursor < bytes)
      }
      assert.equal(cursor, bytes)
      assert.equal(assembled, payload, `Corrupted Unicode at maxBytes=${limit}`)
    }
  })
})

test("readLogFrom: UTF-8 running log waits for a complete UTF-8 codepoint", async () => {
  await withJob(
    Buffer.from([0xf0, 0x9f]),
    async (jobs, log) => {
      const initial = await jobs.readLogFrom("log", 0, 1024)
      assert.equal(initial.output, "", "Do not emit a permanent replacement for unfinished UTF-8")
      assert.equal(initial.nextCursor, 0)
      assert.equal(initial.truncated, true)
      await appendFile(log, Buffer.from([0x98, 0x80]))
      const later = await jobs.readLogFrom("log", initial.nextCursor, 1024)
      assert.equal(later.output, "😀")
      assert.equal(later.nextCursor, 4)
      assert.equal(later.truncated, false)
    },
    "running"
  )
})

test("readLogFrom: UTF-8 invalid UTF-8 prefixes never stall a running log cursor", async () => {
  const invalid = [
    [0xf0, 0x41], // invalid continuation after a four-byte lead
    [0xe0, 0x80], // overlong three-byte prefix
    [0xed, 0xa0], // surrogate codepoint prefix
    [0xf0, 0x8f], // overlong four-byte prefix
    [0xf4, 0x90], // beyond U+10FFFF
    [0xc2, 0x20], // invalid continuation after two-byte lead
  ]
  for (const bytes of invalid) {
    await withJob(
      Buffer.from(bytes),
      async (jobs) => {
        let cursor = 0
        let output = ""
        for (let attempt = 0; cursor < bytes.length && attempt < 5; attempt++) {
          const part = await jobs.readLogFrom("log", cursor, 1)
          assert.ok(part.nextCursor > cursor, `Cursor stalled on ${bytes.toString()}`)
          cursor = part.nextCursor
          output += part.output
        }
        assert.equal(cursor, bytes.length)
        assert.ok(output.includes("\uFFFD"), "Malformed input must be decoded with replacement")
      },
      "running"
    )
  }
})

test("readLogFrom: UTF-8 permanently incomplete bytes on completed log do not stall forever", async () => {
  await withJob(Buffer.from([0xf0, 0x9f]), async (jobs) => {
    const part = await jobs.readLogFrom("log", 0, 1024)
    assert.ok(part.output.length > 0)
    assert.equal(part.nextCursor, 2)
    assert.equal(part.truncated, false)
  })
})

test("readLogFrom: UTF-8 malformed input produces identical text regardless of read boundaries", async () => {
  const samples = [
    [0xe2, 0x82, 0x41], // valid prefix followed by non-continuation
    [0xf0, 0x9f, 0x98, 0x41], // invalid fourth byte
    [0xed, 0xa0, 0x80, 0x41], // surrogate
    [0xe0, 0x80, 0x80, 0x41], // overlong
    [0xff, 0x41],
    [0xe2, 0x82], // incomplete terminal sequence
    [0xf0, 0x9f, 0x98], // incomplete terminal sequence
  ]
  let seed = 73071
  for (let index = 0; index < 28; index++) {
    const bytes: number[] = []
    for (let offset = 0; offset < 9; offset++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      bytes.push(seed & 0xff)
    }
    samples.push(bytes)
  }
  await withJob("", async (jobs, log) => {
    for (const sample of samples) {
      const raw = Buffer.from(sample)
      await writeFile(log, raw)
      for (const limit of [1, 2, 3, 4, 7]) {
        let cursor = 0
        let output = ""
        for (let read = 0; read < raw.length + 2 && cursor < raw.length; read++) {
          const part = await jobs.readLogFrom("log", cursor, limit)
          assert.ok(part.nextCursor > cursor, "Malformed UTF-8 must not stall a terminal job")
          cursor = part.nextCursor
          output += part.output
        }
        assert.equal(cursor, raw.length)
        assert.equal(output, raw.toString("utf8"), `Unexpected decoding at limit=${limit}`)
      }
    }
  })
})

test("readLogFrom: growing append-only log returns every byte in order and exposes remaining output", async () => {
  await withJob("first-", async (jobs, log) => {
    const first = await jobs.readLogFrom("log", 0, 3)
    assert.equal(first.output, "fir")
    assert.equal(first.nextCursor, 3)
    assert.equal(first.truncated, true)
    await appendFile(log, "second")
    let result = first.output
    let cursor = first.nextCursor
    for (let i = 0; i < 6; i++) {
      const part = await jobs.readLogFrom("log", cursor, 4)
      result += part.output
      cursor = part.nextCursor
      if (!part.truncated) break
    }
    assert.equal(result, "first-second")
    const end = await jobs.readLogFrom("log", cursor, 8)
    assert.equal(end.output, "")
    assert.equal(end.nextCursor, cursor)
    assert.equal(end.truncated, false)
  })
})

test("readLogFrom: if a log shrinks past the previous byte cursor, reader restarts from zero", async () => {
  await withJob("some much longer original log", async (jobs, log) => {
    const first = await jobs.readLogFrom("log", 0, 1024)
    assert.equal(first.truncated, false)
    await writeFile(log, "NEW")
    const second = await jobs.readLogFrom("log", first.nextCursor, 1024)
    assert.equal(second.output, "NEW")
    assert.equal(second.nextCursor, 3)
    assert.equal(second.truncated, false)
  })
})

test("streamLogProgress: a timed-out process can append without extending the snapshot", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async () => {
  const payload = `${"x".repeat(33_000)}END`
  await withJob("", async (jobs, _logPath, root) => {
    const fixture = join(root, "writer.cjs")
    const release = join(root, "release")
    const lateOutput = "LATE_OUTPUT"
    await writeFile(
      fixture,
      `
      const fs = require("node:fs")
      process.on("SIGTERM", () => {
        const timer = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(release)})) return
          clearInterval(timer)
          fs.writeSync(1, ${JSON.stringify(lateOutput)})
          process.exit(0)
        }, 10)
      })
      fs.writeSync(1, "x".repeat(33000) + "END")
      setTimeout(() => process.exit(1), 6000)
    `
    )
    const job = await jobs.start(
      "Timeout writer",
      `exec "${process.execPath}" "${fixture}"`,
      root,
      undefined,
      2_000
    )
    const terminal = await jobs.wait(job.id, 4_000)
    assert.equal(terminal.job.status, "failed")
    assert.equal(terminal.job.timedOut, true)
    const fragments: string[] = []
    await jobs.streamLogProgress(job.id, 1_000, 0, async (part) => {
      fragments.push(part)
      if (fragments.length !== 1) return
      await writeFile(release, "")
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await readFile(job.logPath, "utf8")).endsWith(lateOutput)) return
        await delay(20)
      }
    })
    assert.equal(await readFile(job.logPath, "utf8"), payload + lateOutput)
    assert.equal(fragments.join(""), payload)
  })
})

test("streamLogProgress: abort stops a terminal drain between chunks", async () => {
  await withJob(
    "x".repeat(40_000),
    async (jobs) => {
      const controller = new AbortController()
      const reason = new Error("Stop streaming")
      let chunks = 0
      await assert.rejects(
        jobs.streamLogProgress(
          "log",
          1_000,
          0,
          async () => {
            chunks++
            controller.abort(reason)
          },
          controller.signal
        ),
        reason
      )
      assert.equal(chunks, 1)
    },
    "failed"
  )
})

test("streamLogProgress: shrinking the snapshot below the cursor stops without rewinding", {
  timeout: 5_000,
}, async () => {
  await withJob("x".repeat(40_000), async (jobs, logPath) => {
    const fragments: string[] = []
    await jobs.streamLogProgress("log", 1_000, 0, async (part) => {
      fragments.push(part)
      await truncate(logPath, 10)
    })
    assert.deepEqual(fragments, ["x".repeat(16_384)])
  })
})

test("streamLogProgress: an initial stale cursor resets without dropping later chunks", async () => {
  const payload = `${"x".repeat(33_000)}END`
  await withJob(payload, async (jobs) => {
    const fragments: string[] = []
    await jobs.streamLogProgress("log", 1_000, 50_000, async (part) => {
      fragments.push(part)
    })
    const streamed = fragments.join("")
    assert.equal(streamed.length, payload.length)
    assert.equal(streamed, payload)
  })
})

test("streamLogProgress: rechecks completion when the first notification outlasts the deadline", {
  timeout: 10_000,
}, async () => {
  await withJob("", async (jobs, _logPath, root) => {
    const before = "x".repeat(20_000)
    const release = join(root, "release")
    const script = join(root, "writer.cjs")
    const tail = "COMPLETED"
    await writeFile(
      script,
      `
      const fs = require("node:fs")
      fs.writeSync(1, "x".repeat(20000))
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return
        clearInterval(timer)
        fs.writeSync(1, ${JSON.stringify(tail)})
        process.exit(0)
      }, 10)
      setTimeout(() => process.exit(1), 6000).unref()
    `
    )
    const invocation =
      process.platform === "win32" ? `& "${process.execPath}"` : `exec "${process.execPath}"`
    const job = await jobs.start("Progress deadline writer", `${invocation} "${script}"`, root)
    const waitBudget = 1_000
    const waitStarted = Date.now()
    const fragments: string[] = []
    let duringFirstNotification: string | undefined
    await jobs.streamLogProgress(job.id, waitBudget, 0, async (part) => {
      fragments.push(part)
      if (fragments.length !== 1) return
      duringFirstNotification = (await jobs.get(job.id)).status
      await writeFile(release, "")
      await jobs.wait(job.id, 4_000)
      await delay(Math.max(0, waitStarted + waitBudget + 25 - Date.now()))
    })
    assert.equal(duringFirstNotification, "running")
    assert.equal((await jobs.get(job.id)).status, "completed")
    const streamed = fragments.join("")
    assert.equal(streamed.length, before.length + tail.length)
    assert.equal(streamed, before + tail)
  })
})
