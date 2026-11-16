import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { TimelineRegistry } from "../src/timeline/timeline-registry.js"

test("timeline registry appends and lists events", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-timeline-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new TimelineRegistry(join(root, "timeline.json"))

  await registry.append({ type: "system", label: "first" })
  await registry.append({ type: "project", label: "second", projectId: "p1" })

  const all = await registry.list()
  assert.equal(all.length, 2)
  assert.equal(all[0]?.label, "second")
  const filtered = await registry.list({ projectId: "p1" })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0]?.label, "second")
})

for (const [label, contents] of [
  ["truncated", '{"events":['],
  ["schema-invalid", '{"events":[{"id":42}]}'],
] as const) {
  test(`timeline registry quarantines ${label} state and continues empty`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `openchatx-timeline-corrupt-${label}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const statePath = join(root, "timeline.json")
    await writeFile(statePath, contents, "utf8")

    const registry = new TimelineRegistry(statePath)
    assert.deepEqual(await registry.list(), [])

    const quarantined = (await readdir(root)).filter((name) =>
      name.startsWith("timeline.json.corrupt-")
    )
    assert.equal(quarantined.length, 1)
    assert.equal(await readFile(join(root, quarantined[0] ?? ""), "utf8"), contents)

    await registry.append({ type: "system", label: "after quarantine" })
    assert.equal((await registry.list()).length, 1)
  })
}

test("timeline registry does not quarantine a valid file on a transient read error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-timeline-read-error-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  // A directory as the state path makes readFile fail with EISDIR (a non-ENOENT
  // I/O error) while no parsing is involved. It must be rethrown, not treated
  // as corrupt state that gets moved aside and replaced with an empty registry.
  const statePath = join(root, "timeline.json")
  await mkdir(statePath)

  const registry = new TimelineRegistry(statePath)
  await assert.rejects(() => registry.list(), { code: "EISDIR" })

  assert.equal(
    (await readdir(root)).some((name) => name.startsWith("timeline.json.corrupt-")),
    false,
    "a successful read is required before quarantining as corrupt"
  )
})

test("timeline registry persists atomically without leaving temp files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-timeline-atomic-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, "timeline.json")
  const registry = new TimelineRegistry(statePath)

  await registry.append({ type: "system", label: "atomic" })
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).events.length, 1)
  assert.equal(
    (await readdir(root)).some(
      (name) => name.startsWith(".timeline.json.") && name.endsWith(".tmp")
    ),
    false
  )
})
