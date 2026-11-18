import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"

import { z } from "zod"

import { childProcessEnvironment } from "../child-environment.js"
import { MCP_CONFIG } from "../config.js"
import { isProcessRunning, shellCommandArgs, signalProcessTree } from "../host-platform.js"
import { desktopNotificationService } from "../notifications/notification-service.js"

export type JobStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted"

export interface DurableJob {
  id: string
  label: string
  command: string
  cwd: string
  projectId?: string
  pid: number
  status: JobStatus
  createdAt: string
  updatedAt: string
  exitCode?: number
  timedOut?: boolean
  killAfterAt?: string
  logPath: string
}

const jobSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  cwd: z.string(),
  projectId: z.string().optional(),
  pid: z.number().int().positive(),
  status: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  exitCode: z.number().int().optional(),
  timedOut: z.boolean().optional(),
  killAfterAt: z.string().optional(),
  logPath: z.string(),
})
const jobStateSchema = z.object({ jobs: z.array(jobSchema) })

const MAX_LOG_BYTES = 128 * 1024
// A UTF-8 codepoint occupies at most four bytes. The small lookahead lets a
// cursor-based reader return whole characters even if maxBytes splits one.
const UTF8_MAX_LOOKAHEAD = 3

function invalidUtf8SecondByte(lead: number, second: number): boolean {
  return (
    (lead === 0xe0 && second < 0xa0) ||
    (lead === 0xed && second > 0x9f) ||
    (lead === 0xf0 && second < 0x90) ||
    (lead === 0xf4 && second > 0x8f)
  )
}

function utf8Unit(buffer: Buffer, start: number): { end: number; incomplete: boolean } {
  const first = buffer.readUInt8(start)
  let width = 1
  if (first >= 0xc2 && first <= 0xdf) width = 2
  else if (first >= 0xe0 && first <= 0xef) width = 3
  else if (first >= 0xf0 && first <= 0xf4) width = 4

  // A UTF-8 decoder replaces one maximal malformed prefix per replacement
  // character. Treat that prefix as one indivisible cursor unit.
  let end = start + 1
  while (end < start + width && end < buffer.length) {
    const byte = buffer.readUInt8(end)
    if ((byte & 0xc0) !== 0x80 || (end === start + 1 && invalidUtf8SecondByte(first, byte))) {
      return { end, incomplete: false }
    }
    end++
  }
  return { end, incomplete: end === buffer.length && end < start + width }
}

function utf8ChunkLength(buffer: Buffer, maxBytes: number, running: boolean): number {
  const limit = Math.min(buffer.length, maxBytes)
  let cursor = 0
  let lastBoundary = 0
  while (cursor < buffer.length) {
    const unit = utf8Unit(buffer, cursor)
    // Only an actually valid but unfinished unit can wait for future bytes.
    if (running && unit.incomplete) return lastBoundary
    if (unit.end > limit && lastBoundary > 0) return lastBoundary
    if (unit.end >= limit) return unit.end
    lastBoundary = unit.end
    cursor = unit.end
  }
  return cursor
}

export interface DurableJobLogSlice {
  job: DurableJob
  output: string
  /** True when this response has not yet returned every currently available byte. */
  truncated: boolean
  nextCursor: number
}

export class JobManager {
  private readonly jobs = new Map<string, DurableJob>()
  private readonly ownedRunningPids = new Set<number>()
  private readonly killTimers = new Map<string, NodeJS.Timeout>()
  private loadPromise?: Promise<void>
  private persistChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly root = join(MCP_CONFIG.stateDir, "jobs"),
    private readonly statePath = join(root, "jobs.json")
  ) {}

  async start(
    label: string,
    command: string,
    cwd = MCP_CONFIG.defaultCwd,
    projectId?: string,
    killAfterMs?: number
  ): Promise<DurableJob> {
    await this.ensureLoaded()
    const resolvedCwd = resolve(cwd)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const createdAt = new Date().toISOString()
    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const logPath = join(this.root, `${id}.log`)
    const handle = await open(logPath, "a", 0o600)
    try {
      const child = spawn(MCP_CONFIG.shell.path, shellCommandArgs(command), {
        cwd: resolvedCwd,
        env: childProcessEnvironment(),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", handle.fd, handle.fd],
      })
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => {
          child.once("exit", (code, signal) => resolveExit({ code, signal }))
        }
      )
      await new Promise<void>((resolvePromise, reject) => {
        child.once("error", reject)
        child.once("spawn", resolvePromise)
      })
      if (!child.pid) throw new Error("Durable job started without a process id.")
      const childPid = child.pid
      const job: DurableJob = {
        id,
        label,
        command,
        cwd: resolvedCwd,
        ...(projectId ? { projectId } : {}),
        pid: childPid,
        status: "running",
        createdAt,
        updatedAt: createdAt,
        ...(killAfterMs ? { killAfterAt: new Date(Date.now() + killAfterMs).toISOString() } : {}),
        logPath,
      }
      this.jobs.set(id, job)
      this.ownedRunningPids.add(childPid)
      await this.persist()
      this.scheduleKill(job)
      void exit
        .then(async ({ code, signal }) => {
          this.clearKillTimer(id)
          try {
            const current = this.jobs.get(id)
            if (current?.status !== "running") return
            current.status = code === 0 ? "completed" : "failed"
            current.exitCode = code ?? (signal ? -1 : 1)
            current.updatedAt = new Date().toISOString()
            await this.persist()
            try {
              await desktopNotificationService.notify(
                "jobFinished",
                current.status === "completed" ? "OpenChatX job completed" : "OpenChatX job failed",
                current.label
              )
            } catch {
              // Desktop notifications are best effort.
            }
          } finally {
            this.ownedRunningPids.delete(childPid)
          }
        })
        .catch((error) => {
          console.warn(`Failed to persist durable job ${id} settlement: ${describeError(error)}`)
        })
      child.unref()
      return { ...job }
    } finally {
      await handle.close()
    }
  }

  async list(): Promise<DurableJob[]> {
    await this.ensureLoaded()
    await this.reconcile()
    await this.persistChain
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async get(id: string): Promise<DurableJob> {
    await this.ensureLoaded()
    await this.reconcile()
    await this.persistChain
    const job = this.jobs.get(id)
    if (!job) throw new Error(`Unknown durable job ${JSON.stringify(id)}.`)
    return { ...job }
  }

  async readLog(
    id: string,
    maxBytes = 16 * 1024
  ): Promise<{ job: DurableJob; output: string; truncated: boolean }> {
    const job = await this.get(id)
    const limit = Math.min(Math.max(maxBytes, 1), MAX_LOG_BYTES)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      // This is deliberately a tail read, unlike cursor-based readLogFrom().
      // Seek rather than loading the entire potentially huge job log into RAM.
      handle = await open(job.logPath, "r")
      const size = (await handle.stat()).size
      const start = Math.max(0, size - limit)
      const length = size - start
      const data = Buffer.alloc(length)
      let bytesRead = 0
      while (bytesRead < length) {
        const part = await handle.read(data, bytesRead, length - bytesRead, start + bytesRead)
        if (!part.bytesRead) break
        bytesRead += part.bytesRead
      }
      return { job, output: data.subarray(0, bytesRead).toString("utf8"), truncated: size > limit }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      return { job, output: "", truncated: false }
    } finally {
      await handle?.close()
    }
  }

  async readLogFrom(id: string, cursor = 0, maxBytes = 16 * 1024): Promise<DurableJobLogSlice> {
    return (await this.readLogSlice(id, cursor, maxBytes)).part
  }

  private async readLogSlice(
    id: string,
    cursor: number,
    maxBytes: number,
    endOffset?: number
  ): Promise<{ part: DurableJobLogSlice; startOffset: number; endOffset: number }> {
    const job = await this.get(id)
    const limit = Math.min(Math.max(maxBytes, 1), MAX_LOG_BYTES)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(job.logPath, "r")
      const logSize = (await handle.stat()).size
      const size = endOffset === undefined ? logSize : Math.min(logSize, endOffset)
      // Ordinary reads restart after truncation; a terminal drain must not rewind.
      const boundedCursor = cursor > size && endOffset === undefined ? 0 : Math.max(cursor, 0)
      const unread = Math.max(0, size - boundedCursor)
      // Incremental cursor reads must not skip unread bytes.
      const start = boundedCursor
      const length = Math.min(unread, limit + UTF8_MAX_LOOKAHEAD)
      const buffer = Buffer.alloc(length)
      let bytesRead = 0
      while (bytesRead < length) {
        const part = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead)
        if (!part.bytesRead) break
        bytesRead += part.bytesRead
      }
      const emittedBytes = utf8ChunkLength(
        buffer.subarray(0, bytesRead),
        limit,
        job.status === "running"
      )
      return {
        part: {
          job,
          output: buffer.subarray(0, emittedBytes).toString("utf8"),
          truncated: size > start + emittedBytes,
          nextCursor: start + emittedBytes,
        },
        startOffset: start,
        endOffset: size,
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      return {
        part: { job, output: "", truncated: false, nextCursor: 0 },
        startOffset: 0,
        endOffset: 0,
      }
    } finally {
      await handle?.close()
    }
  }

  async wait(
    id: string,
    waitMs: number,
    cursor = 0,
    maxBytes = 16 * 1024,
    signal?: AbortSignal
  ): Promise<DurableJobLogSlice> {
    await this.waitForJob(id, waitMs, signal)
    return this.readLogFrom(id, cursor, maxBytes)
  }

  async streamLogProgress(
    id: string,
    waitMs: number,
    initialCursor: number,
    onProgress: (output: string) => Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + waitMs
    let cursor = initialCursor
    let endOffset: number | undefined
    for (;;) {
      signal?.throwIfAborted()
      if (endOffset === undefined) {
        const remaining = deadline - Date.now()
        if (remaining > 0) {
          await this.waitForJob(id, Math.min(750, remaining), signal)
        } else if ((await this.get(id)).status === "running") {
          // A slow notification can span both completion and the wait deadline.
          // Check once without waiting; only a terminal job gets drained now.
          break
        }
      }
      const {
        part,
        startOffset,
        endOffset: observedEnd,
      } = await this.readLogSlice(id, cursor, 16 * 1024, endOffset)
      // Terminal status doesn't guarantee that the producer has stopped.
      // Drain only the EOF sampled by the first terminal read, even past the deadline.
      if (part.job.status !== "running") endOffset ??= observedEnd
      signal?.throwIfAborted()
      if (part.output) await onProgress(part.output).catch(() => undefined)
      signal?.throwIfAborted()
      if (endOffset !== undefined && (!part.truncated || part.nextCursor <= startOffset)) break
      cursor = part.nextCursor
    }
  }

  private async waitForJob(id: string, waitMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + Math.max(waitMs, 0)
    let job = await this.get(id)
    while (job.status === "running" && Date.now() < deadline) {
      const remaining = deadline - Date.now()
      await delay(Math.min(250, remaining), undefined, { signal })
      job = await this.get(id)
    }
  }

  async cancel(id: string): Promise<DurableJob> {
    await this.ensureLoaded()
    const job = this.jobs.get(id)
    if (!job) throw new Error(`Unknown durable job ${JSON.stringify(id)}.`)
    // A late cancellation must not rewrite a completed or failed result.
    if (job.status !== "running") {
      await this.persistChain // A terminal result must be durable before it is acknowledged.
      return { ...job }
    }
    if (isProcessRunning(job.pid)) {
      try {
        signalProcessTree(job.pid, "SIGTERM")
      } catch {
        // The process may have exited between the liveness check and signal delivery.
      }
    }
    job.status = "cancelled"
    job.updatedAt = new Date().toISOString()
    this.clearKillTimer(id)
    await this.persist()
    return { ...job }
  }

  async close(): Promise<void> {
    for (const id of this.killTimers.keys()) this.clearKillTimer(id)
    await this.persist()
  }

  async initialize(): Promise<void> {
    await this.ensureLoaded()
  }

  async forget(id: string): Promise<void> {
    await this.ensureLoaded()
    const job = this.jobs.get(id)
    if (!job) return
    if (job.status === "running") throw new Error("Cannot forget a running durable job.")
    this.clearKillTimer(id)
    this.jobs.delete(id)
    await this.persist()
    await rm(job.logPath, { force: true })
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    try {
      const parsed = jobStateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")))
      for (const job of parsed.jobs) this.jobs.set(job.id, job)
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) await this.quarantineCorruptState(error)
    }
    await this.reconcile()
    for (const job of this.jobs.values()) this.scheduleKill(job)
  }

  private async quarantineCorruptState(error: unknown): Promise<void> {
    const quarantinePath = `${this.statePath}.corrupt-${Date.now()}`
    const reason = describeError(error)
    try {
      await rename(this.statePath, quarantinePath)
      console.warn(
        `OpenChatX durable job state was invalid (${reason}) and has been quarantined to ${JSON.stringify(quarantinePath)}. Starting with an empty job state.`
      )
    } catch (quarantineError) {
      if (!isNodeErrorCode(quarantineError, "ENOENT")) {
        const quarantineReason = describeError(quarantineError)
        console.warn(
          `OpenChatX durable job state was invalid (${reason}) and could not be quarantined (${quarantineReason}). Starting with an empty job state.`
        )
      }
    }
    this.jobs.clear()
  }

  private async reconcile(): Promise<void> {
    let changed = false
    for (const job of this.jobs.values()) {
      if (job.status === "running" && this.deadlineExpired(job)) {
        this.timeoutJob(job)
        changed = true
        continue
      }
      if (
        job.status !== "running" ||
        this.ownedRunningPids.has(job.pid) ||
        isProcessRunning(job.pid)
      )
        continue
      job.status = "interrupted"
      job.updatedAt = new Date().toISOString()
      changed = true
    }
    if (changed) await this.persist()
  }

  private scheduleKill(job: DurableJob): void {
    this.clearKillTimer(job.id)
    if (job.status !== "running" || !job.killAfterAt) return
    const delayMs = new Date(job.killAfterAt).getTime() - Date.now()
    if (delayMs <= 0) {
      this.timeoutJob(job)
      void this.persist().catch((error) => {
        console.warn(`Failed to persist timed-out durable job ${job.id}: ${describeError(error)}`)
      })
      return
    }
    const timer = setTimeout(() => {
      this.killTimers.delete(job.id)
      const current = this.jobs.get(job.id)
      if (current?.status !== "running") return
      this.timeoutJob(current)
      void this.persist().catch((error) => {
        console.warn(
          `Failed to persist timed-out durable job ${current.id}: ${describeError(error)}`
        )
      })
    }, delayMs)
    timer.unref()
    this.killTimers.set(job.id, timer)
  }

  private deadlineExpired(job: DurableJob): boolean {
    return Boolean(job.killAfterAt && Date.now() >= new Date(job.killAfterAt).getTime())
  }

  private timeoutJob(job: DurableJob): void {
    if (isProcessRunning(job.pid)) {
      try {
        signalProcessTree(job.pid, "SIGTERM")
      } catch {
        // Process may have exited between the liveness check and signal delivery.
      }
    }
    this.ownedRunningPids.delete(job.pid)
    job.status = "failed"
    job.timedOut = true
    job.exitCode = -1
    job.updatedAt = new Date().toISOString()
  }

  private clearKillTimer(id: string): void {
    const timer = this.killTimers.get(id)
    if (timer) clearTimeout(timer)
    this.killTimers.delete(id)
  }

  private async persist(): Promise<void> {
    const payload = { jobs: [...this.jobs.values()] }
    const serialized = `${JSON.stringify(payload, null, 2)}\n`
    const pending = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 })
        await this.writeStateAtomically(serialized)
      })
    this.persistChain = pending
    await pending
  }

  private async writeStateAtomically(serialized: string): Promise<void> {
    const directory = dirname(this.statePath)
    const tempPath = join(
      directory,
      `.${basename(this.statePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
    )
    try {
      await writeFile(tempPath, serialized, {
        encoding: "utf8",
        mode: 0o600,
      })
      await rename(tempPath, this.statePath)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? "Unknown error"
  } catch {
    return "Unknown error"
  }
}
