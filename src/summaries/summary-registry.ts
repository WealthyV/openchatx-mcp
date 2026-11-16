import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import process from "node:process"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"

const summarySchema = z.object({
  uuid: z.uuid(),
  content: z.string().min(1),
  recentContext: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const stateSchema = z.object({
  summaries: z.array(summarySchema).default([]),
})

export type TemporarySummary = z.infer<typeof summarySchema>

export class SummaryRegistry {
  private readonly summaries = new Map<string, TemporarySummary>()
  private loadPromise?: Promise<void>
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private readonly statePath = join(MCP_CONFIG.stateDir, "summaries.json")) {}

  async list(): Promise<TemporarySummary[]> {
    await this.ensureLoaded()
    return [...this.summaries.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneSummary)
  }

  async create(content: string, recentContext = ""): Promise<TemporarySummary> {
    await this.ensureLoaded()
    const text = normalizeContent(content)
    const now = new Date().toISOString()
    const summary = summarySchema.parse({
      uuid: randomUUID(),
      content: text,
      recentContext: recentContext.trim(),
      createdAt: now,
      updatedAt: now,
    })
    this.summaries.set(summary.uuid, summary)
    await this.persist()
    return cloneSummary(summary)
  }

  async get(uuid: string): Promise<TemporarySummary> {
    await this.ensureLoaded()
    const summary = this.summaries.get(normalizeUuid(uuid))
    if (!summary) throw new Error(`Unknown summary UUID ${JSON.stringify(uuid)}.`)
    return cloneSummary(summary)
  }

  async update(uuid: string, content: string, recentContext = ""): Promise<TemporarySummary> {
    await this.ensureLoaded()
    const id = normalizeUuid(uuid)
    const existing = this.summaries.get(id)
    if (!existing) throw new Error(`Unknown summary UUID ${JSON.stringify(uuid)}.`)
    const summary = summarySchema.parse({
      ...existing,
      content: normalizeContent(content),
      recentContext: recentContext.trim(),
      updatedAt: new Date().toISOString(),
    })
    this.summaries.set(id, summary)
    await this.persist()
    return cloneSummary(summary)
  }

  async remove(uuid: string): Promise<void> {
    await this.ensureLoaded()
    const id = normalizeUuid(uuid)
    if (!this.summaries.delete(id)) throw new Error(`Unknown summary UUID ${JSON.stringify(uuid)}.`)
    await this.persist()
  }

  async consume(uuid: string): Promise<TemporarySummary> {
    await this.ensureLoaded()
    const id = normalizeUuid(uuid)
    const summary = this.summaries.get(id)
    if (!summary) throw new Error(`Unknown summary UUID ${JSON.stringify(uuid)}.`)
    this.summaries.delete(id)
    await this.persist()
    return cloneSummary(summary)
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.statePath, "utf8")
    } catch (error) {
      if (isEnoent(error)) return
      // A transient read failure (EIO, EACCES, ...) must not be treated as
      // corruption: leave the file untouched so valid state is not hidden.
      throw error
    }
    try {
      const state = stateSchema.parse(JSON.parse(raw))
      for (const summary of state.summaries) this.summaries.set(summary.uuid, summary)
    } catch (error) {
      // Only malformed/truncated content is quarantined.
      await this.quarantineCorruptState(error)
    }
  }

  private async quarantineCorruptState(error: unknown): Promise<void> {
    const quarantinePath = `${this.statePath}.corrupt-${Date.now()}`
    try {
      await rename(this.statePath, quarantinePath)
      console.warn(
        `OpenChatX summary state was invalid (${describeError(error)}) and has been quarantined to ${JSON.stringify(quarantinePath)}. Starting with an empty summary state.`
      )
    } catch (quarantineError) {
      if (!isEnoent(quarantineError)) {
        console.warn(
          `OpenChatX summary state was invalid (${describeError(error)}) and could not be quarantined (${describeError(quarantineError)}). Starting with an empty summary state.`
        )
      }
    }
    this.summaries.clear()
  }

  private async persist(): Promise<void> {
    const serialized = `${JSON.stringify({ summaries: [...this.summaries.values()] }, null, 2)}\n`
    const pending = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
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
      await writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600 })
      await rename(tempPath, this.statePath)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeContent(content: string): string {
  const text = content.trim()
  if (!text) throw new Error("Summary content is required.")
  return text
}

function normalizeUuid(uuid: string): string {
  return z.uuid().parse(uuid.trim())
}

function cloneSummary(summary: TemporarySummary): TemporarySummary {
  return { ...summary }
}
