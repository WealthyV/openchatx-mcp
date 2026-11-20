import { existsSync, type FSWatcher, lstatSync, watch } from "node:fs"
import { basename, dirname } from "node:path"

import { canonicalExternalMcpConfigPath } from "./config-transaction.js"

export function createExternalMcpConfigWatcher(reload: () => Promise<void>) {
  let watchers: FSWatcher[] = []
  let watchedLogicalPath: string | undefined
  let watchedTargetPath: string | undefined
  let reloadTimer: NodeJS.Timeout | undefined

  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      void reload().catch((error) => {
        console.warn(
          `External MCP config reload failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    }, 150)
    reloadTimer.unref()
  }

  return {
    sync(logicalPath: string, targetPath: string) {
      if (logicalPath === watchedLogicalPath && targetPath === watchedTargetPath) return
      try {
        const next = watchConfigPaths(logicalPath, targetPath, scheduleReload)
        for (const watcher of watchers) watcher.close()
        watchers = next
        watchedLogicalPath = logicalPath
        watchedTargetPath = targetPath
      } catch (error) {
        reportWatchError(error)
      }
    },
    close() {
      for (const watcher of watchers) watcher.close()
      if (reloadTimer) clearTimeout(reloadTimer)
    },
  }
}

function watchConfigPaths(
  logicalPath: string,
  targetPath: string,
  scheduleReload: () => void
): FSWatcher[] {
  const paths = new Set([logicalPath, targetPath])
  for (let dir = dirname(logicalPath); dir !== dirname(dir); dir = dirname(dir)) {
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) paths.add(dir)
  }
  const namesByDirectory = new Map<string, Set<string>>()
  for (const path of paths) {
    const directory = canonicalExternalMcpConfigPath(dirname(path))
    if (!existsSync(directory)) continue
    const names = namesByDirectory.get(directory) ?? new Set<string>()
    names.add(basename(path))
    namesByDirectory.set(directory, names)
  }
  const watchers: FSWatcher[] = []
  for (const [directory, names] of namesByDirectory) {
    try {
      const watcher = watch(directory, (_event, filename) => {
        if (!filename || names.has(filename.toString())) scheduleReload()
      })
      watcher.on("error", reportWatchError)
      watchers.push(watcher)
    } catch (error) {
      reportWatchError(error)
    }
  }
  return watchers
}

function reportWatchError(error: unknown): void {
  console.warn(
    `Could not watch external MCP config: ${error instanceof Error ? error.message : String(error)}`
  )
}
