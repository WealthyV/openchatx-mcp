import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { registerMcpServerManagementTools } from "../src/tools/mcp-server-management/mcp-server-management-tools.js"

async function withConfig(
  initial: string | undefined,
  reload: () => Promise<void>,
  run: (client: Client, path: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openchatx-mcp-config-rollback-"))
  const path = join(dir, "mcp-servers.json")
  const server = new McpServer({ name: "mcp-rollback-test", version: "1.0.0" })
  const client = new Client({ name: "mcp-rollback-client", version: "1.0.0" })
  try {
    if (initial !== undefined) await writeFile(path, initial)
    registerMcpServerManagementTools(server, path, { reload } as never)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(a), server.connect(b)])
    await run(client, path)
  } finally {
    await Promise.all([client.close(), server.close()])
    await rm(dir, { recursive: true, force: true })
  }
}

const create = {
  name: "mcp_server_manage",
  arguments: {
    action: "create",
    server_id: "synthetic",
    type: "remote",
    url: "https://example.invalid/mcp",
    enabled: false,
  },
} as const

test("failed reload leaves the previously stored configuration intact", async () => {
  let attempts = 0
  await withConfig(
    "{}\n",
    async () => {
      attempts++
      throw new Error("SYNTHETIC_RELOAD_FAILURE")
    },
    async (client, path) => {
      const result = await client.callTool(create)
      assert.equal(result.isError, true)
      const state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
      assert.equal(state.synthetic, undefined)
      assert.equal(attempts, 2)
    }
  )
})

test("failed reload removes newly created configuration files", async () => {
  await withConfig(
    undefined,
    async () => {
      throw new Error("SYNTHETIC_RELOAD_FAILURE")
    },
    async (client, path) => {
      const result = await client.callTool(create)
      assert.equal(result.isError, true)
      await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" })
    }
  )
})

test("a successful reload persists configuration without rollback", async () => {
  let attempts = 0
  await withConfig(
    "{}\n",
    async () => {
      attempts++
    },
    async (client, path) => {
      const result = await client.callTool(create)
      assert.notEqual(result.isError, true)
      const state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
      assert.notEqual(state.synthetic, undefined)
      assert.equal(attempts, 1)
    }
  )
})

test("a failed reload cannot roll back a concurrent successful mutation", async () => {
  let releaseFirst: (() => void) | undefined
  let startedFirst: (() => void) | undefined
  const firstReloadGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const firstReloadStarted = new Promise<void>((resolve) => {
    startedFirst = resolve
  })
  let attempts = 0
  try {
    await withConfig(
      "{}\n",
      async () => {
        attempts++
        if (attempts === 1) {
          startedFirst?.()
          await firstReloadGate
          throw new Error("SYNTHETIC_FIRST_RELOAD_FAILURE")
        }
      },
      async (client, path) => {
        const first = client.callTool({
          ...create,
          arguments: { ...create.arguments, server_id: "first" },
        })
        await firstReloadStarted
        const second = client.callTool({
          ...create,
          arguments: { ...create.arguments, server_id: "second" },
        })
        // The unprotected implementation lets the second request persist
        // while the first reload is paused, then overwrites it on rollback.
        await new Promise((resolve) => setTimeout(resolve, 250))
        releaseFirst?.()
        const [failed, succeeded] = await Promise.all([first, second])
        assert.equal(failed.isError, true)
        assert.notEqual(succeeded.isError, true)
        const state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
        assert.equal(state.first, undefined)
        assert.notEqual(state.second, undefined)
      }
    )
    assert.equal(attempts, 3)
  } finally {
    releaseFirst?.()
  }
})

test("mcp_server_list waits for a pending reload instead of exposing provisional config", async () => {
  let releaseReload: (() => void) | undefined
  let signalReload: (() => void) | undefined
  const reloadGate = new Promise<void>((resolve) => {
    releaseReload = resolve
  })
  const reloadStarted = new Promise<void>((resolve) => {
    signalReload = resolve
  })
  try {
    await withConfig(
      "{}\n",
      async () => {
        signalReload?.()
        await reloadGate
        throw new Error("SYNTHETIC_RELOAD_FAILURE")
      },
      async (client, path) => {
        const update = client.callTool(create)
        await reloadStarted
        let listSettled = false
        const listing = client
          .callTool({ name: "mcp_server_list", arguments: {} })
          .then((value) => {
            listSettled = true
            return value
          })
        await new Promise((resolve) => setTimeout(resolve, 100))
        assert.equal(listSettled, false)
        releaseReload?.()
        assert.equal((await update).isError, true)
        const result = await listing
        assert.notEqual(result.isError, true)
        const state = (result.structuredContent as { servers: Record<string, unknown> }).servers
        assert.equal(state.synthetic, undefined)
        assert.equal(
          (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>).synthetic,
          undefined
        )
      }
    )
  } finally {
    releaseReload?.()
  }
})
