import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import {
  type ExternalMcpConfig,
  type ExternalMcpServerConfig,
  loadExternalMcpConfig,
  saveExternalMcpConfig,
} from "../../external-mcp/config.js"
import type { ExternalMcpRegistry } from "../../external-mcp/registry.js"
import { toToolError } from "../../mcp/tool-error.js"

const actionSchema = z.enum(["create", "update", "delete", "enable", "disable"])

// Keep reload/rollback transactions for the same config path in one queue.
// Otherwise a failed reload can roll back a second, successful mutation.
const mutationsByPath = new Map<string, Promise<void>>()

async function serializeConfigMutation<T>(path: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(path)
  const previous = mutationsByPath.get(key) ?? Promise.resolve()
  const pending = previous.then(action, action)
  const finished = pending.then(
    () => undefined,
    () => undefined
  )
  mutationsByPath.set(key, finished)
  try {
    return await pending
  } finally {
    if (mutationsByPath.get(key) === finished) mutationsByPath.delete(key)
  }
}

const manageInputSchema = z.object({
  action: actionSchema,
  server_id: z.string().min(1),
  type: z.enum(["local", "remote"]).optional(),
  url: z.string().url().nullable().optional(),
  command: z.array(z.string().min(1)).min(1).nullable().optional(),
  cwd: z.string().min(1).nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  environment: z.record(z.string(), z.string()).nullable().optional(),
  timeout: z.number().int().positive().nullable().optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
})

export function registerMcpServerManagementTools(
  server: McpServer,
  configPath: string | (() => string) = () => MCP_CONFIG.externalMcp.configFile,
  registry?: ExternalMcpRegistry
): void {
  server.registerTool(
    "mcp_server_list",
    {
      description:
        "List configured local and remote MCP servers. Secret-bearing header and environment values are redacted.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const path = typeof configPath === "function" ? configPath() : configPath
        // Take a serialized snapshot; an overlapping reload must not expose
        // a provisional config which may still be rolled back.
        const config = await serializeConfigMutation(path, async () => loadExternalMcpConfig(path))
        return {
          structuredContent: { servers: redactConfig(config) },
          content: [],
        }
      } catch (error) {
        throw toToolError(error, "MCP_SERVER_MANAGE_FAILED")
      }
    }
  )

  server.registerTool(
    "mcp_server_manage",
    {
      description:
        "Create, update, delete, enable, or disable an external MCP server in mcp-servers.json. Changes are validated, hot-reloaded, and available without restarting openchatx-mcp.",
      inputSchema: manageInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const path = typeof configPath === "function" ? configPath() : configPath
        return await serializeConfigMutation(path, async () => {
          const current = loadExternalMcpConfig(path)
          const next = applyAction(current, input)
          const existed = existsSync(path)
          let saved: ExternalMcpConfig
          try {
            saved = saveExternalMcpConfig(path, next)
            await registry?.reload()
          } catch (updateError) {
            // Both write failures and reload failures can leave partial changes.
            // Restore inside the same serialized transaction.
            try {
              if (existed) saveExternalMcpConfig(path, current)
              else await rm(path, { force: true })
              await registry?.reload()
            } catch (recoveryError) {
              // Preserve both failures; AggregateError already includes the original cause.
              // biome-ignore lint/style/useErrorCause: AggregateError contains both failures and a cause.
              throw new AggregateError(
                [updateError, recoveryError],
                "MCP config update failed and recovery could not complete.",
                { cause: updateError }
              )
            }
            throw updateError
          }
          return {
            structuredContent: {
              ok: true,
              restart_required: false,
              servers: redactConfig(saved),
            },
            content: [
              {
                type: "text" as const,
                text: "Saved and hot-reloaded MCP server configuration.",
              },
            ],
          }
        })
      } catch (error) {
        throw toToolError(error, "MCP_SERVER_MANAGE_FAILED")
      }
    }
  )
}

type ManageInput = z.infer<typeof manageInputSchema>

function applyAction(current: ExternalMcpConfig, input: ManageInput): ExternalMcpConfig {
  const next = { ...current }
  const existing = current[input.server_id]

  if (input.action === "delete") {
    if (!existing) throw new Error(`Unknown MCP server ${JSON.stringify(input.server_id)}.`)
    delete next[input.server_id]
    return next
  }

  if (input.action === "enable" || input.action === "disable") {
    if (!existing) throw new Error(`Unknown MCP server ${JSON.stringify(input.server_id)}.`)
    next[input.server_id] = { ...existing, enabled: input.action === "enable" }
    return next
  }

  if (input.action === "create" && existing) {
    throw new Error(`MCP server ${JSON.stringify(input.server_id)} already exists.`)
  }
  if (input.action === "update" && !existing) {
    throw new Error(`Unknown MCP server ${JSON.stringify(input.server_id)}.`)
  }

  next[input.server_id] = buildServerConfig(existing, input)
  return next
}

function buildServerConfig(
  existing: ExternalMcpServerConfig | undefined,
  input: ManageInput
): ExternalMcpServerConfig {
  const type = input.type ?? existing?.type
  if (!type) throw new Error("type is required when creating an MCP server.")

  const description = nullableValue(input.description, existing?.description)
  const timeout = nullableValue(input.timeout, existing?.timeout)
  const common = {
    enabled: input.enabled ?? existing?.enabled ?? true,
    ...(existing?.disabledTools ? { disabledTools: existing.disabledTools } : {}),
    ...(description === undefined ? {} : { description }),
    ...(timeout === undefined ? {} : { timeout }),
  }

  if (type === "remote") {
    const previous = existing?.type === "remote" ? existing : undefined
    const url = input.url ?? previous?.url
    if (!url) throw new Error("url is required for a remote MCP server.")
    const headers = nullableValue(input.headers, previous?.headers)
    return {
      type: "remote",
      url,
      ...common,
      ...(headers === undefined ? {} : { headers }),
    }
  }

  const previous = existing?.type === "local" ? existing : undefined
  const command = input.command ?? previous?.command
  if (!command) throw new Error("command is required for a local MCP server.")
  const cwd = nullableValue(input.cwd, previous?.cwd)
  const environment = nullableValue(input.environment, previous?.environment)
  return {
    type: "local",
    command,
    ...common,
    ...(cwd === undefined ? {} : { cwd }),
    ...(environment === undefined ? {} : { environment }),
  }
}

function nullableValue<Value>(
  supplied: Value | null | undefined,
  previous: Value | undefined
): Value | undefined {
  return supplied === null ? undefined : (supplied ?? previous)
}

function redactConfig(config: ExternalMcpConfig) {
  return Object.fromEntries(
    Object.entries(config).map(([id, server]) => [
      id,
      server.type === "remote"
        ? {
            ...server,
            ...(server.headers ? { headers: redactRecord(server.headers) } : {}),
          }
        : {
            ...server,
            ...(server.environment ? { environment: redactRecord(server.environment) } : {}),
          },
    ])
  )
}

function redactRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).map((key) => [key, "<redacted>"]))
}
