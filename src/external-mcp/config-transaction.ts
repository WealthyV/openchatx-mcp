import { lstatSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs"
import { basename, dirname, isAbsolute, resolve, sep } from "node:path"
import process from "node:process"

import { type ExternalMcpConfig, parseExternalMcpConfig, writeExternalMcpConfig } from "./config.js"

const transactions = new Map<string, Promise<void>>()
const retryPath = Symbol()

export function absoluteExternalMcpConfigPath(path: string, base?: string): string {
  if (process.platform === "win32") return base === undefined ? resolve(path) : resolve(base, path)
  // POSIX resolves a parent component relative to any symlink already traversed.
  return isAbsolute(path) ? path : appendPath(base ?? process.cwd(), path)
}

export function canonicalExternalMcpConfigPath(path: string): string {
  const absolute = absoluteExternalMcpConfigPath(path)
  try {
    return realpathSync.native(absolute)
  } catch (error) {
    if (!isMissing(error)) throw error
    const parent = dirname(absolute)
    if (parent === absolute) return absolute
    if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
      const target = readlinkSync(absolute)
      return canonicalExternalMcpConfigPath(absoluteExternalMcpConfigPath(target, parent))
    }
    const name = basename(absolute)
    return appendPath(
      canonicalExternalMcpConfigPath(parent),
      absolute.endsWith(sep) ? `${name}${sep}` : name
    )
  }
}

export async function withExternalMcpConfig<T>(
  path: string,
  operation: (canonicalPath: string) => T | Promise<T>
): Promise<T> {
  for (;;) {
    const canonicalPath = canonicalExternalMcpConfigPath(path)
    const previous = transactions.get(canonicalPath) ?? Promise.resolve()
    const pending = previous.then<T | typeof retryPath>(() =>
      canonicalExternalMcpConfigPath(path) === canonicalPath ? operation(canonicalPath) : retryPath
    )
    const finished = pending.then(
      () => undefined,
      () => undefined
    )
    transactions.set(canonicalPath, finished)
    try {
      const result = await pending
      if (result !== retryPath) return result
    } finally {
      if (transactions.get(canonicalPath) === finished) transactions.delete(canonicalPath)
    }
    // The configured path was retargeted while waiting. Join the new target's queue.
  }
}

export function updateExternalMcpConfig(
  path: string,
  update: (canonicalPath: string) => unknown,
  reload?: (canonicalPath: string) => Promise<void>
): Promise<ExternalMcpConfig> {
  return withExternalMcpConfig(path, async (canonicalPath) => {
    const next = parseExternalMcpConfig(update(canonicalPath))
    const previous = readConfigBytes(canonicalPath)
    const contents = Buffer.from(`${JSON.stringify(next, null, 2)}\n`)
    let written = false
    try {
      writeExternalMcpConfig(canonicalPath, contents)
      written = true
      await reload?.(canonicalPath)
      return next
    } catch (updateError) {
      try {
        // A direct file edit can land while the registry reload is pending.
        if (!written || readConfigBytes(canonicalPath)?.equals(contents)) {
          if (previous === undefined) rmSync(canonicalPath, { force: true })
          else writeExternalMcpConfig(canonicalPath, previous)
        }
        await reload?.(canonicalPath)
      } catch (recoveryError) {
        // biome-ignore lint/style/useErrorCause: AggregateError receives the cause in its third argument.
        throw new AggregateError(
          [updateError, recoveryError],
          "MCP config update failed and recovery could not complete.",
          { cause: updateError }
        )
      }
      throw updateError
    }
  })
}

function appendPath(parent: string, child: string): string {
  return parent.endsWith(sep) ? `${parent}${child}` : `${parent}${sep}${child}`
}

function readConfigBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
