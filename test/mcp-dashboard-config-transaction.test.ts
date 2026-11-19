import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import express from "express"

import { createDashboardRouter } from "../src/agent/dashboard-routes.js"
import { createAgentObserver } from "../src/agent/observer.js"
import { MCP_CONFIG } from "../src/config.js"
import { updateExternalMcpConfig } from "../src/external-mcp/config-transaction.js"
import {
  createExternalMcpRegistry,
  type ExternalMcpRegistry,
} from "../src/external-mcp/registry.js"
import { registerMcpServerManagementTools } from "../src/tools/mcp-server-management/mcp-server-management-tools.js"
import { tempDir } from "./helpers/temp.js"

const syntheticServer = { type: "remote", url: "https://example.invalid/mcp", enabled: false }
const dashboardServers = { dashboard: syntheticServer }

async function fixture(t: TestContext, reload: () => Promise<void>) {
  const dir = await tempDir(t, "openchatx-mcp-dashboard-")
  const path = join(dir, "mcp-servers.json")
  await writeFile(path, "{}\n")
  const originalPath = MCP_CONFIG.externalMcp.configFile
  MCP_CONFIG.externalMcp.configFile = path
  t.after(() => {
    MCP_CONFIG.externalMcp.configFile = originalPath
  })

  const registry: ExternalMcpRegistry = {
    reload,
    connectedServers: [],
    toolCount: 0,
    capabilities: () => [],
    registerTools: () => {},
    registerResources: () => {},
    catalog: () => [],
    detectedTools: () => [],
    call: async () => undefined,
    close: async () => {},
  }
  const server = new McpServer({ name: "test-server", version: "1.0.0" })
  const client = new Client({ name: "test-client", version: "1.0.0" })
  let mcpEntered: (() => void) | undefined
  registerMcpServerManagementTools(
    server,
    () => {
      mcpEntered?.()
      return path
    },
    registry
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))

  const dashboard = createDashboardRouter(createAgentObserver(), { externalMcp: registry })
  const entered = new Map<string, () => void>()
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    dashboard(req, res, next)
    entered.get(req.method)?.()
  })
  const http = app.listen(0, "127.0.0.1")
  t.after(() => {
    http.close()
    http.closeAllConnections()
  })
  await once(http, "listening")
  const address = http.address()
  assert.ok(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/api/mcp-servers`

  const mcp = (request: Parameters<Client["callTool"]>[0]) => {
    const { promise, resolve } = deferred()
    mcpEntered = resolve
    return { entered: promise, response: client.callTool(request) }
  }
  return {
    mcpCreate: () =>
      mcp({
        name: "mcp_server_manage",
        arguments: { action: "create", server_id: "mcp", ...syntheticServer },
      }),
    mcpList: () => mcp({ name: "mcp_server_list", arguments: {} }),
    dashboard: (
      method: "GET" | "PUT",
      servers: Record<string, typeof syntheticServer> = dashboardServers
    ) => {
      const { promise, resolve } = deferred()
      entered.set(method, resolve)
      const response = fetch(
        url,
        method === "GET"
          ? undefined
          : {
              method,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ servers }),
            }
      )
      return { entered: promise, response }
    },
    read: async (): Promise<unknown> => JSON.parse(await readFile(path, "utf8")),
  }
}

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function pauseReload() {
  const started = deferred()
  const release = deferred()
  return {
    started: started.promise,
    release: release.resolve,
    pause: () => {
      started.resolve()
      return release.promise
    },
  }
}

test("rollback preserves a Dashboard save that overlaps a failed MCP reload", async (t) => {
  const reload = pauseReload()
  let attempts = 0
  const config = await fixture(t, async () => {
    if (++attempts === 1) {
      await reload.pause()
      throw new Error("Reload failed")
    }
  })
  const update = config.mcpCreate()
  await reload.started
  const dashboard = config.dashboard("PUT")
  try {
    await dashboard.entered
  } finally {
    reload.release()
  }
  assert.equal((await update.response).isError, true)
  assert.equal((await dashboard.response).status, 200)
  assert.deepEqual(await config.read(), dashboardServers)
})

test("a failed MCP update restores the preceding Dashboard save and allows the next save", async (t) => {
  const reloadFailure = new Error("Reload failed")
  let attempts = 0
  const config = await fixture(t, async () => {
    if (++attempts === 2) throw reloadFailure
  })

  const before = await config.dashboard("PUT").response
  assert.equal(before.status, 200)
  const failed = await config.mcpCreate().response
  assert.equal(failed.isError, true)
  assert.match(JSON.stringify(failed.content), /Reload failed/)
  assert.equal(attempts, 3)
  assert.deepEqual(await config.read(), dashboardServers)

  const afterServers = { replacement: syntheticServer }
  const after = await config.dashboard("PUT", afterServers).response
  assert.equal(after.status, 200)
  assert.deepEqual(await config.read(), afterServers)
  assert.equal(attempts, 4)
})

test("an MCP update builds on a concurrent successful Dashboard save", async (t) => {
  const reload = pauseReload()
  let attempts = 0
  const config = await fixture(t, async () => {
    if (++attempts === 1) await reload.pause()
  })

  const dashboard = config.dashboard("PUT")
  await reload.started
  const update = config.mcpCreate()
  try {
    await update.entered
  } finally {
    reload.release()
  }
  const [saved, managed] = await Promise.all([dashboard.response, update.response])
  assert.equal(saved.status, 200)
  assert.deepEqual(await saved.json(), {
    servers: dashboardServers,
    authorization: {},
    restartRequired: false,
  })
  assert.equal(managed.isError, undefined)
  assert.equal(attempts, 2)
  assert.deepEqual(await config.read(), { ...dashboardServers, mcp: syntheticServer })
})

test("Dashboard GET and MCP list read committed configuration after rollback", async (t) => {
  const reload = pauseReload()
  let attempts = 0
  const config = await fixture(t, async () => {
    if (++attempts === 1) {
      await reload.pause()
      throw new Error("Reload failed")
    }
  })

  const update = config.mcpCreate()
  await reload.started
  const dashboard = config.dashboard("GET")
  const listing = config.mcpList()
  try {
    await Promise.all([dashboard.entered, listing.entered])
  } finally {
    reload.release()
  }
  const [managed, snapshot, listed] = await Promise.all([
    update.response,
    dashboard.response,
    listing.response,
  ])
  assert.equal(managed.isError, true)
  assert.equal(snapshot.status, 200)
  assert.deepEqual(await snapshot.json(), { servers: {}, authorization: {}, tools: [] })
  assert.deepEqual(listed.structuredContent, { servers: {} })
})

test("a Dashboard reload failure rolls back and returns the original HTTP error", async (t) => {
  let attempts = 0
  const config = await fixture(t, async () => {
    if (++attempts === 1) throw new Error("Reload failed")
  })

  const response = await config.dashboard("PUT").response
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: "Reload failed" })
  assert.deepEqual(await config.read(), {})
  assert.equal(attempts, 2)

  assert.equal((await config.mcpCreate().response).isError, undefined)
  assert.deepEqual(await config.read(), { mcp: syntheticServer })
})

test("recovery preserves both errors and the original file bytes", async (t) => {
  const dir = await tempDir(t, "openchatx-mcp-recovery-")
  const path = join(dir, "mcp-servers.json")
  const original = '{ "legacy": { "type": "local", "command": ["synthetic"] } }\n'
  await writeFile(path, original)
  const updateError = new Error("Reload failed")
  const recoveryError = new Error("Recovery reload failed")
  let attempts = 0

  await assert.rejects(
    updateExternalMcpConfig(
      path,
      () => dashboardServers,
      async () => {
        throw ++attempts === 1 ? updateError : recoveryError
      }
    ),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.cause, updateError)
      assert.deepEqual(error.errors, [updateError, recoveryError])
      return true
    }
  )
  assert.equal(await readFile(path, "utf8"), original)
  await updateExternalMcpConfig(path, () => dashboardServers)
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), dashboardServers)
})

test("registry reload through a directory alias waits for the transaction to recover", async (t) => {
  const dir = await tempDir(t, "openchatx-mcp-alias-")
  const target = join(dir, "target")
  const alias = join(dir, "alias")
  await mkdir(target)
  await symlink(target, alias, "junction")
  const path = join(target, "mcp-servers.json")
  const registry = await createExternalMcpRegistry(join(alias, "mcp-servers.json"))
  t.after(() => registry.close())
  const reload = pauseReload()
  let attempts = 0
  const update = assert.rejects(
    updateExternalMcpConfig(
      path,
      () => dashboardServers,
      async () => {
        if (++attempts === 1) {
          await reload.pause()
          throw new Error("Reload failed")
        }
      }
    ),
    /Reload failed/
  )
  await reload.started
  const snapshot = registry.reload(true).then(() => registry.authorization?.())
  reload.release()
  await update
  assert.deepEqual(await snapshot, {})
  await updateExternalMcpConfig(
    path,
    () => dashboardServers,
    (transactionPath) => registry.reload(false, transactionPath)
  )
  assert.deepEqual(Object.keys(registry.authorization?.() ?? {}), ["dashboard"])
})
