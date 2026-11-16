import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import process from "node:process"

import { MCP_CONFIG } from "../config.js"
import { updateOperationalState } from "../recovery/operational-state.js"
import { RELEASE_DOWNLOAD_PREFIX, type UpdateCheckResult } from "./version-check.js"

const SAFE_SEGMENT = /[^0-9A-Za-z._-]+/gu
const WINDOWS_INSTALLER_NAME_PATTERN = /^OpenChatX-Setup-(?:x64|arm64)\.exe$/u
const DECIMAL_PID_PATTERN = /^\d+$/u

export interface WindowsUpdateLaunchResult {
  version: string
  installerPath: string
  installerName: string
}

export function buildWindowsUpdaterScript(): string {
  return `$ErrorActionPreference = "Stop"
$Installer = $env:OPENCHATX_UPDATE_INSTALLER
$TargetExe = $env:OPENCHATX_TARGET_APP
$TargetPid = [int]$env:OPENCHATX_TARGET_PID
$BackupDir = $env:OPENCHATX_UPDATE_BACKUP_DIR
$StatePath = $env:OPENCHATX_OPERATIONAL_STATE_PATH
$StateBackup = $env:OPENCHATX_OPERATIONAL_STATE_BACKUP
$StateExisted = $env:OPENCHATX_OPERATIONAL_STATE_EXISTED -eq "1"
$HealthUrl = $env:OPENCHATX_UPDATE_HEALTH_URL
$TargetDir = Split-Path -Parent $TargetExe

function Stop-TargetApp {
  # Snapshot the process table once, then walk every generation below the known
  # desktop PID. Direct-child matching alone misses node/browser grandchildren.
  $processes = @(Get-CimInstance Win32_Process)
  $processById = @{}
  $childrenByParent = @{}
  foreach ($process in $processes) {
    $processId = [int]$process.ProcessId
    $processById[$processId] = $process
    $parentId = [int]$process.ParentProcessId
    if (-not $childrenByParent.ContainsKey($parentId)) {
      $childrenByParent[$parentId] = [System.Collections.Generic.List[object]]::new()
    }
    $childrenByParent[$parentId].Add($process)
  }

  # The detached updater can still appear below the desktop PID in the
  # process table. Protect this PowerShell process and its own children so the
  # rollback script never terminates itself.
  $protectedProcessIds = @{}
  $protectedQueue = [System.Collections.Generic.Queue[int]]::new()
  $protectedQueue.Enqueue($PID)
  while ($protectedQueue.Count -gt 0) {
    $protectedId = $protectedQueue.Dequeue()
    if ($protectedProcessIds.ContainsKey($protectedId)) { continue }
    $protectedProcessIds[$protectedId] = $true
    foreach ($child in $childrenByParent[$protectedId]) {
      $protectedQueue.Enqueue([int]$child.ProcessId)
    }
  }

  $descendantDepth = @{}
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue(@{ ProcessId = $TargetPid; Depth = 0 })
  while ($queue.Count -gt 0) {
    $entry = $queue.Dequeue()
    $children = $childrenByParent[[int]$entry.ProcessId]
    foreach ($child in $children) {
      $childId = [int]$child.ProcessId
      if (
        $childId -eq $TargetPid -or
        $protectedProcessIds.ContainsKey($childId) -or
        $descendantDepth.ContainsKey($childId)
      ) {
        continue
      }
      $depth = [int]$entry.Depth + 1
      $descendantDepth[$childId] = $depth
      $queue.Enqueue(@{ ProcessId = $childId; Depth = $depth })
    }
  }

  # Stop the desktop root first so it cannot spawn more children, then stop
  # captured descendants from deepest to shallowest and other app instances.
  # Do not swallow enumeration/termination failures: rollback must not delete an
  # install directory while a process can still hold files inside it.
  if ($processById.ContainsKey($TargetPid)) {
    Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue
  }
  $descendants = @(
    foreach ($processId in $descendantDepth.Keys) {
      $processById[[int]$processId]
    }
  ) | Sort-Object { $descendantDepth[[int]$_.ProcessId] } -Descending
  foreach ($process in $descendants) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  $otherAppProcesses = @(
    $processes | Where-Object {
      $_.ExecutablePath -eq $TargetExe -and
      -not $descendantDepth.ContainsKey([int]$_.ProcessId) -and
      [int]$_.ProcessId -ne $TargetPid
    }
  )
  foreach ($process in $otherAppProcesses) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }

  $deadline = (Get-Date).AddSeconds(5)
  do {
    $remaining = @(
      Get-CimInstance Win32_Process | Where-Object {
        $descendantDepth.ContainsKey([int]$_.ProcessId) -or
        [int]$_.ProcessId -eq $TargetPid -or
        $_.ExecutablePath -eq $TargetExe
      }
    )
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)

  if ($remaining.Count -gt 0) {
    $remainingIds = ($remaining | ForEach-Object { $_.ProcessId }) -join ", "
    throw "Unable to stop OpenChatX process tree: $remainingIds"
  }
}

function Restore-PreviousVersion {
  Stop-TargetApp
  Start-Sleep -Milliseconds 500
  if (Test-Path $TargetDir) {
    Remove-Item -LiteralPath $TargetDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  Copy-Item -Path (Join-Path $BackupDir "*") -Destination $TargetDir -Recurse -Force

  if ($StateExisted -and (Test-Path $StateBackup)) {
    Copy-Item -LiteralPath $StateBackup -Destination $StatePath -Force
  } elseif (-not $StateExisted -and (Test-Path $StatePath)) {
    Remove-Item -LiteralPath $StatePath -Force
  }

  Start-Process -FilePath $TargetExe
}

Start-Sleep -Milliseconds 800
$installerProcess = Start-Process -FilePath $Installer -ArgumentList @(
  "/SILENT",
  "/SUPPRESSMSGBOXES",
  "/CLOSEAPPLICATIONS",
  "/NORESTART"
) -PassThru -Wait

if ($installerProcess.ExitCode -ne 0) {
  Restore-PreviousVersion
  exit $installerProcess.ExitCode
}

Start-Process -FilePath $TargetExe

$healthy = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 1
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
      $healthy = $true
      break
    }
  } catch {}
  Start-Sleep -Milliseconds 500
}

if ($healthy) {
  Remove-Item -LiteralPath $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $StateBackup -Force -ErrorAction SilentlyContinue
  exit 0
}

Restore-PreviousVersion
exit 1
`
}

export async function launchWindowsDesktopUpdate(
  update: UpdateCheckResult
): Promise<WindowsUpdateLaunchResult> {
  if (process.platform !== "win32" || process.env.OPENCHATX_DESKTOP !== "1") {
    throw new Error("In-app installation is only available in the Windows desktop app.")
  }
  if (!update.updateAvailable || !update.latestVersion) {
    throw new Error("No OpenChatX update is available.")
  }
  if (!update.downloadUrl || !update.downloadName) {
    throw new Error("This release does not contain a compatible Windows installer.")
  }
  if (
    !update.downloadUrl.startsWith(RELEASE_DOWNLOAD_PREFIX) ||
    !WINDOWS_INSTALLER_NAME_PATTERN.test(update.downloadName)
  ) {
    throw new Error("The update asset is not a trusted OpenChatX Windows installer.")
  }

  const targetApp = process.env.OPENCHATX_DESKTOP_APP_PATH?.trim()
  const targetPid = process.env.OPENCHATX_DESKTOP_APP_PID?.trim()
  if (
    !targetApp ||
    basename(targetApp).toLowerCase() !== "openchatx.exe" ||
    !targetPid ||
    !DECIMAL_PID_PATTERN.test(targetPid)
  ) {
    throw new Error("Could not resolve the running OpenChatX Windows desktop app.")
  }
  await access(dirname(targetApp), constants.R_OK | constants.W_OK)

  const response = await fetch(update.downloadUrl, {
    headers: { "User-Agent": `OpenChatX/${update.currentVersion}` },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    throw new Error(`OpenChatX installer download failed with HTTP ${response.status}.`)
  }

  const versionDirectory = update.latestVersion.replace(SAFE_SEGMENT, "_")
  const updateDirectory = join(tmpdir(), "OpenChatX", "updates", versionDirectory)
  const backupDirectory = join(updateDirectory, "previous-install")
  const installerPath = join(updateDirectory, update.downloadName)
  const scriptPath = join(updateDirectory, "install-windows-update.ps1")
  const statePath = join(MCP_CONFIG.stateDir, "operational-state.json")
  const stateBackup = join(updateDirectory, "operational-state.preupdate.json")

  await mkdir(updateDirectory, { recursive: true })
  await writeFile(installerPath, Buffer.from(await response.arrayBuffer()))

  await rm(backupDirectory, { recursive: true, force: true })
  await cp(dirname(targetApp), backupDirectory, {
    recursive: true,
    force: true,
    errorOnExist: false,
  })

  let stateExisted = false
  try {
    await copyFile(statePath, stateBackup)
    stateExisted = true
  } catch (error) {
    if (!isEnoent(error)) throw error
  }

  await writeFile(scriptPath, buildWindowsUpdaterScript(), { encoding: "utf8", mode: 0o600 })
  await updateOperationalState((state) => {
    state.update.phase = "installing"
    state.update.progress = 75
  })

  const updater = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env: {
        ...process.env,
        OPENCHATX_UPDATE_INSTALLER: installerPath,
        OPENCHATX_TARGET_APP: targetApp,
        OPENCHATX_TARGET_PID: targetPid,
        OPENCHATX_UPDATE_BACKUP_DIR: backupDirectory,
        OPENCHATX_OPERATIONAL_STATE_PATH: statePath,
        OPENCHATX_OPERATIONAL_STATE_BACKUP: stateBackup,
        OPENCHATX_OPERATIONAL_STATE_EXISTED: stateExisted ? "1" : "0",
        OPENCHATX_UPDATE_HEALTH_URL: `http://127.0.0.1:${MCP_CONFIG.port}/healthz`,
      },
    }
  )
  updater.unref()

  return {
    version: update.latestVersion,
    installerPath,
    installerName: update.downloadName,
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
