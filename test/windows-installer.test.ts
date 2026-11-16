import assert from "node:assert/strict"
import test from "node:test"

import { buildWindowsUpdaterScript } from "../src/update/windows-installer.js"

test("Windows updater health-checks the new app and rolls back install plus operational state", () => {
  const script = buildWindowsUpdaterScript()

  assert.match(script, /OPENCHATX_UPDATE_BACKUP_DIR/u)
  assert.match(script, /OPENCHATX_OPERATIONAL_STATE_PATH/u)
  assert.match(script, /OPENCHATX_OPERATIONAL_STATE_BACKUP/u)
  assert.match(script, /function Restore-PreviousVersion/u)
  assert.match(script, /Copy-Item -Path \(Join-Path \$BackupDir "\*"\)/u)
  assert.match(script, /Copy-Item -LiteralPath \$StateBackup -Destination \$StatePath -Force/u)
  assert.match(script, /Invoke-WebRequest -UseBasicParsing -Uri \$HealthUrl/u)
  assert.match(script, /Start-Process -FilePath \$TargetExe/u)
  assert.match(script, /Restore-PreviousVersion/u)
})

test("Windows updater recursively terminates descendants before rollback", () => {
  const script = buildWindowsUpdaterScript()

  // Walk the process table from the target PID so grandchildren and deeper
  // browser/helper processes are included, not only direct children.
  assert.match(script, /\$childrenByParent = @\{\}/u)
  assert.match(script, /\$queue\.Enqueue\(@\{ ProcessId = \$TargetPid; Depth = 0 \}\)/u)
  assert.match(script, /\$queue\.Dequeue\(\)/u)
  assert.match(script, /\$protectedQueue\.Enqueue\(\$PID\)/u)
  assert.match(script, /\$protectedProcessIds\.ContainsKey\(\$childId\)/u)
  assert.match(script, /\$childrenByParent\[\[int\]\$entry\.ProcessId\]/u)
  assert.match(script, /\$queue\.Enqueue\(@\{ ProcessId = \$childId; Depth = \$depth \}\)/u)

  // Terminate deepest descendants before the root and fail closed if any
  // process from the captured tree or another app instance remains alive.
  assert.match(script, /Sort-Object \{ \$descendantDepth\[\[int\]\$_.ProcessId\] \} -Descending/u)
  assert.match(script, /Stop-Process -Id \(\[int\]\$process\.ProcessId\) -Force/u)
  assert.match(script, /Unable to stop OpenChatX process tree/u)
})
