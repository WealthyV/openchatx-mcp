import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { CapabilityStoreService } from "../src/store/store-service.js"

test("Capability Store installs and removes bundled toolboxes with ownership state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-store-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bundles = join(root, "bundles")
  const toolboxRoot = join(root, "toolboxes")
  await mkdir(join(bundles, "demo"), { recursive: true })
  await writeFile(join(bundles, "demo", "toolbox.json"), '{"name":"Demo"}\n')
  const catalog = join(root, "catalog.json")
  await writeFile(
    catalog,
    JSON.stringify({
      entries: [
        {
          id: "demo",
          name: "Demo",
          description: "Demo capability",
          kind: "toolbox",
          bundle: "demo",
          tags: ["demo"],
        },
      ],
    })
  )

  const store = new CapabilityStoreService(catalog, bundles, toolboxRoot, undefined, root)
  assert.equal((await store.list())[0]?.installed, false)
  const installed = await store.install("demo")
  assert.equal(installed.installed, true)
  assert.match(await readFile(join(toolboxRoot, "demo", "toolbox.json"), "utf8"), /Demo/u)
  await assert.rejects(() => store.install("demo"), /already installed/u)
  await store.uninstall("demo")
  assert.equal((await store.list())[0]?.installed, false)
})

test("concurrent installs do not lose ownership state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-store-concurrent-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bundles = join(root, "bundles")
  const toolboxRoot = join(root, "toolboxes")
  const catalog = join(root, "catalog.json")
  const entries = ["alpha", "beta"].map((id) => ({
    id,
    name: id,
    description: `${id} capability`,
    kind: "toolbox",
    bundle: id,
    tags: [id],
  }))
  for (const entry of entries) {
    await mkdir(join(bundles, entry.id), { recursive: true })
    await writeFile(join(bundles, entry.id, "toolbox.json"), `{"name":"${entry.id}"}\n`)
  }
  await writeFile(catalog, JSON.stringify({ entries }))

  const store = new CapabilityStoreService(catalog, bundles, toolboxRoot, undefined, root)
  await Promise.all([store.install("alpha"), store.install("beta")])

  const persisted = JSON.parse(await readFile(join(root, "capability-store.json"), "utf8"))
  assert.deepEqual(Object.keys(persisted.installed).sort(), ["alpha", "beta"])
  assert.equal((await store.list()).filter((entry) => entry.installed).length, 2)
  assert.equal(
    (await readdir(root)).some(
      (name) => name.startsWith(".capability-store.json.") && name.endsWith(".tmp")
    ),
    false
  )
})

test("store state is written atomically without leaving temp files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-store-atomic-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bundles = join(root, "bundles")
  const toolboxRoot = join(root, "toolboxes")
  await mkdir(join(bundles, "solo"), { recursive: true })
  await writeFile(join(bundles, "solo", "toolbox.json"), '{"name":"Solo"}\n')
  const catalog = join(root, "catalog.json")
  await writeFile(
    catalog,
    JSON.stringify({
      entries: [
        {
          id: "solo",
          name: "Solo",
          description: "Solo capability",
          kind: "toolbox",
          bundle: "solo",
        },
      ],
    })
  )

  const store = new CapabilityStoreService(catalog, bundles, toolboxRoot, undefined, root)
  await store.install("solo")
  assert.equal(
    Object.keys(JSON.parse(await readFile(join(root, "capability-store.json"), "utf8")).installed)
      .length,
    1
  )
  assert.equal(
    (await readdir(root)).some(
      (name) => name.startsWith(".capability-store.json.") && name.endsWith(".tmp")
    ),
    false
  )
})
