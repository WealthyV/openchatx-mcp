import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { SummaryRegistry } from "../src/summaries/summary-registry.js"

test("summary registry creates, edits, lists, consumes, and persists temporary summaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-summaries-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, "summaries.json")
  const registry = new SummaryRegistry(statePath)

  const created = await registry.create(" first summary ", " ### User\nKeep this exact request. ")
  assert.match(created.uuid, /^[0-9a-f-]{36}$/u)
  assert.equal(created.content, "first summary")
  assert.equal(created.recentContext, "### User\nKeep this exact request.")
  assert.equal((await registry.list()).length, 1)

  const updated = await registry.update(
    created.uuid,
    "edited summary",
    "### Assistant\nContinue from here."
  )
  assert.equal(updated.content, "edited summary")
  assert.equal(updated.recentContext, "### Assistant\nContinue from here.")
  assert.equal((await registry.get(created.uuid)).content, "edited summary")

  const reloaded = new SummaryRegistry(statePath)
  assert.equal((await reloaded.get(created.uuid)).content, "edited summary")
  assert.equal(
    (await reloaded.get(created.uuid)).recentContext,
    "### Assistant\nContinue from here."
  )

  const consumed = await reloaded.consume(created.uuid)
  assert.equal(consumed.content, "edited summary")
  assert.equal(consumed.recentContext, "### Assistant\nContinue from here.")
  assert.equal((await reloaded.list()).length, 0)
  await assert.rejects(() => reloaded.get(created.uuid), /Unknown summary UUID/u)
})

test("summary registry loads legacy summaries without recent context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-summaries-legacy-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, "summaries.json")
  const now = new Date().toISOString()
  await writeFile(
    statePath,
    JSON.stringify({
      summaries: [
        {
          uuid: "123e4567-e89b-12d3-a456-426614174000",
          content: "legacy summary",
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
  )

  const registry = new SummaryRegistry(statePath)
  const [summary] = await registry.list()
  assert.equal(summary?.content, "legacy summary")
  assert.equal(summary?.recentContext, "")
})

test("summary registry manually removes summaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-summaries-delete-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new SummaryRegistry(join(root, "summaries.json"))

  const created = await registry.create("delete me")
  await registry.remove(created.uuid)
  assert.deepEqual(await registry.list(), [])
})

for (const [label, contents] of [
  ["truncated", '{"summaries":['],
  ["schema-invalid", '{"summaries":[{"uuid":42}]}'],
] as const) {
  test(`summary registry quarantines ${label} state and continues empty`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `openchatx-summaries-corrupt-${label}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const statePath = join(root, "summaries.json")
    await writeFile(statePath, contents, "utf8")

    const registry = new SummaryRegistry(statePath)
    assert.deepEqual(await registry.list(), [])

    const quarantined = (await readdir(root)).filter((name) =>
      name.startsWith("summaries.json.corrupt-")
    )
    assert.equal(quarantined.length, 1)
    assert.equal(await readFile(join(root, quarantined[0] ?? ""), "utf8"), contents)

    await registry.create("after quarantine")
    assert.equal((await registry.list()).length, 1)
  })
}

test("summary registry persists atomically without leaving temp files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-summaries-atomic-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, "summaries.json")
  const registry = new SummaryRegistry(statePath)

  await registry.create("atomic")
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).summaries.length, 1)
  assert.equal(
    (await readdir(root)).some(
      (name) => name.startsWith(".summaries.json.") && name.endsWith(".tmp")
    ),
    false
  )
})
