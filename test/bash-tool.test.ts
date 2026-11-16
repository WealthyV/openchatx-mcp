import assert from "node:assert/strict"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { runWithAgentId, setAgentTaskSlug } from "../src/agent/context.js"
import { createAgentObserver } from "../src/agent/observer.js"
import { JobManager } from "../src/jobs/job-manager.js"
import { installToolRegistrationBoundary } from "../src/mcp/tool-registration-boundary.js"
import { registerJobTools } from "../src/tools/jobs/job-tools.js"
import { BashProcessManager } from "../src/tools/shell/bash-process-manager.js"
import { registerBashProcessTool } from "../src/tools/shell/bash-process-tool.js"
import { registerBashTool } from "../src/tools/shell/bash-tool.js"
import { tempDir } from "./helpers/temp.js"

async function connectedBash(t: test.TestContext) {
  const state = await tempDir(t, "openchatx-bash-manager-")
  const manager = new BashProcessManager(join(state, "logs"))
  const jobs = new JobManager(join(state, "jobs"), join(state, "jobs", "jobs.json"))
  await jobs.initialize()
  const server = new McpServer({ name: "bash-test", version: "1.0.0" })
  const client = new Client({ name: "bash-client", version: "1.0.0" })
  registerBashTool(server, manager, undefined, jobs)
  registerBashProcessTool(server, manager)
  registerJobTools(server, jobs)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close(), jobs.close()]))
  return client
}

test("bash runs in a fresh process with an explicit workdir", async (t) => {
  const cwd = await tempDir(t, "openchatx-bash-")
  await mkdir(join(cwd, "sub"))
  await writeFile(join(cwd, "sub", "marker.txt"), "ok")
  const client = await connectedBash(t)

  const result = await client.callTool({
    name: "bash",
    arguments: { command: "pwd; cat marker.txt", workdir: join(cwd, "sub") },
  })
  assert.equal(result.isError, undefined)
  const output = (result.structuredContent as { output: string }).output
  assert.match(output, new RegExp(join(cwd, "sub").replaceAll("/", "\\/"), "u"))
  assert.match(output, /ok/u)
})

test("bash keep=true is listed, readable, and stoppable", async (t) => {
  const cwd = await tempDir(t, "openchatx-bash-keep-")
  const marker = join(cwd, "ready.txt")
  const client = await connectedBash(t)

  const startedAt = Date.now()
  const result = await client.callTool({
    name: "bash",
    arguments: {
      command: `printf 'server ready\\n'; printf ready > "${marker}"; sleep 30`,
      workdir: cwd,
      keep: true,
    },
  })
  assert.equal(result.isError, undefined)
  assert.ok(Date.now() - startedAt < 5_000)

  const output = result.structuredContent as {
    kept: boolean
    process_id: string
    pid: number
    cwd: string
  }
  assert.equal(output.kept, true)
  assert.equal(output.cwd, cwd)
  assert.ok(output.pid > 0)
  assert.match(output.process_id, /^bash-\d+$/u)

  let markerReady = false
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(marker)
      markerReady = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  assert.equal(markerReady, true)

  const listed = await client.callTool({
    name: "bash_process",
    arguments: { action: "list" },
  })
  assert.match(
    listed.content.find((item) => item.type === "text")?.text ?? "",
    new RegExp(`${output.process_id}.*running=true`, "u")
  )

  const read = await client.callTool({
    name: "bash_process",
    arguments: { action: "read", process_id: output.process_id },
  })
  assert.match(read.content.find((item) => item.type === "text")?.text ?? "", /server ready/u)

  const stopped = await client.callTool({
    name: "bash_process",
    arguments: { action: "stop", process_id: output.process_id },
  })
  assert.match(
    stopped.content.find((item) => item.type === "text")?.text ?? "",
    new RegExp(`${output.process_id}.*running=false`, "u")
  )
})

test("bash does not persist cwd or environment between calls", async (t) => {
  const cwd = await tempDir(t, "openchatx-bash-state-")
  const client = await connectedBash(t)

  await client.callTool({
    name: "bash",
    arguments: { command: "cd /; export OPENCHATX_TEMP=present" },
  })
  const result = await client.callTool({
    name: "bash",
    arguments: { command: "pwd; printf '%s' \"${OPENCHATX_TEMP:-missing}\"", workdir: cwd },
  })
  const output = (result.structuredContent as { output: string }).output
  assert.match(output, new RegExp(cwd.replaceAll("/", "\\/"), "u"))
  assert.match(output, /missing/u)
})

test("bash emits incremental MCP progress for long-running foreground commands", async (t) => {
  const cwd = await tempDir(t, "openchatx-bash-progress-")
  const client = await connectedBash(t)
  const fragments: string[] = []
  const result = await client.callTool(
    {
      name: "bash",
      arguments: {
        command: "printf 'phase-one\\n'; sleep 1; printf 'phase-two\\n'",
        workdir: cwd,
        timeout_ms: 5_000,
      },
    },
    {
      onprogress: (message) => {
        if (message.message) fragments.push(message.message)
      },
    }
  )
  assert.equal(result.isError, undefined)
  const output = (result.structuredContent as { output: string }).output
  assert.match(output, /phase-one/u)
  assert.match(output, /phase-two/u)
  assert.ok(fragments.some((item) => item.includes("phase-one")))
  assert.ok(fragments.some((item) => item.includes("phase-two")))
})

test("job_manage wait streams durable job logs without changing its final response", async (t) => {
  const cwd = await tempDir(t, "openchatx-job-progress-")
  const client = await connectedBash(t)
  const created = await client.callTool({
    name: "job_manage",
    arguments: {
      action: "start",
      label: "Progress fixture",
      cwd,
      command: "printf 'step-one\\n'; sleep 1; printf 'step-two\\n'",
    },
  })
  assert.equal(created.isError, undefined)
  const started = created.structuredContent as { job: { id: string } }
  const fragments: string[] = []
  const result = await client.callTool(
    {
      name: "job_manage",
      arguments: { action: "wait", id: started.job.id, cursor: 0, wait_ms: 5_000 },
    },
    {
      onprogress: (progress) => {
        if (progress.message) fragments.push(progress.message)
      },
    }
  )
  assert.equal(result.isError, undefined)
  const payload = result.structuredContent as { job: { status: string }; output: string }
  assert.equal(payload.job.status, "completed")
  assert.match(payload.output, /step-one/u)
  assert.match(payload.output, /step-two/u)
  assert.ok(fragments.some((part) => part.includes("step-one")))
  assert.ok(fragments.some((part) => part.includes("step-two")))
})

test("bash wait expiry promotes a live command to a durable job", async (t) => {
  const cwd = await tempDir(t, "openchatx-bash-promote-")
  const client = await connectedBash(t)

  const result = await client.callTool({
    name: "bash",
    arguments: {
      command: "printf 'phase-one\\n'; sleep 0.3; printf 'phase-two\\n'",
      workdir: cwd,
      timeout_ms: 50,
    },
  })
  assert.equal(result.isError, undefined)
  const promoted = result.structuredContent as {
    running: boolean
    promoted_to_job: boolean
    job_id: string
    next_cursor: number
    output: string
  }
  assert.equal(promoted.running, true)
  assert.equal(promoted.promoted_to_job, true)
  assert.match(promoted.job_id, /^job-/u)
  assert.match(promoted.output, /phase-one/u)

  const waited = await client.callTool({
    name: "job_manage",
    arguments: {
      action: "wait",
      id: promoted.job_id,
      cursor: promoted.next_cursor,
      wait_ms: 2_000,
    },
  })
  assert.equal(waited.isError, undefined)
  const final = waited.structuredContent as {
    job: { status: string }
    output: string
    next_cursor: number
  }
  assert.equal(final.job.status, "completed")
  assert.match(final.output, /phase-two/u)
  assert.doesNotMatch(final.output, /phase-one/u)
  assert.ok(final.next_cursor > promoted.next_cursor)
})

test("dashboard-style forced stop cancels the durable bash job and returns queued instructions", async (t) => {
  const state = await tempDir(t, "openchatx-bash-force-stop-")
  const cwd = await tempDir(t, "openchatx-bash-force-stop-cwd-")
  const manager = new BashProcessManager(join(state, "logs"))
  const jobs = new JobManager(join(state, "jobs"), join(state, "jobs", "jobs.json"))
  await jobs.initialize()
  const observer = createAgentObserver()
  const server = new McpServer({ name: "bash-stop-test", version: "1.0.0" })
  const client = new Client({ name: "bash-stop-client", version: "1.0.0" })
  installToolRegistrationBoundary(server, {
    structuredOutput: false,
    agentObserver: observer,
  })
  registerBashTool(server, manager, undefined, jobs)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close(), jobs.close()]))

  const agentId = "123e4567-e89b-42d3-a456-426614174000"
  const resultPromise = runWithAgentId(agentId, () => {
    setAgentTaskSlug("bash-force-stop")
    return client.callTool({
      name: "bash",
      arguments: {
        command: "printf 'started\n'; sleep 30",
        workdir: cwd,
        timeout_ms: 30_000,
        agent_id: agentId,
      },
    })
  })

  await waitFor(() => observer.listAgents()[0]?.current?.status === "running")
  const agent = observer.listAgents()[0]
  assert.ok(agent?.current)
  await waitForJobOutput(jobs, /started/u)
  assert.ok(observer.queueInstruction(agent.id, "停止後直接處理下一步"))
  assert.equal(observer.stopTool(agent.id, agent.current.id), true)

  const result = await resultPromise
  assert.notEqual(result.isError, true)
  const content = JSON.stringify(result.content)
  assert.match(content, /started/u)
  assert.match(content, /interrupted by user/u)
  assert.match(content, /Human instruction: 停止後直接處理下一步/u)
  assert.equal(observer.listAgents()[0]?.recent[0]?.status, "interrupted")
  assert.match(observer.listAgents()[0]?.recent[0]?.resultDetail ?? "", /started/u)
  assert.match(observer.listAgents()[0]?.recent[0]?.resultDetail ?? "", /interrupted by user/u)

  const durableJobs = await jobs.list()
  assert.equal(durableJobs.length, 1)
  assert.equal(durableJobs[0]?.status, "cancelled")
})

test("legacy foreground command that ignores SIGTERM is reclaimed via SIGKILL escalation", {
  timeout: 10_000,
}, async (t) => {
  if (process.platform === "win32") return
  const cwd = await tempDir(t, "openchatx-bash-sigkill-")
  const pidFile = join(cwd, "child.pid")

  const server = new McpServer({ name: "bash-sigkill-test", version: "1.0.0" })
  const client = new Client({ name: "bash-sigkill-client", version: "1.0.0" })
  registerBashTool(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))

  // A command that traps (ignores) SIGTERM and keeps running. Without SIGKILL
  // escalation, the foreground runner would hang forever waiting for it to exit.
  const result = await client.callTool({
    name: "bash",
    arguments: {
      command: `echo $$ > "${pidFile}"; trap '' TERM; while true; do sleep 0.2; done`,
      workdir: cwd,
      timeout_ms: 300,
    },
  })
  assert.equal(result.isError, undefined)
  const out = result.structuredContent as { timed_out?: boolean }
  assert.equal(out.timed_out, true)

  // Wait past the SIGTERM -> grace -> SIGKILL window.
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const pid = Number((await readFile(pidFile, "utf8").catch(() => "0")).trim())
  assert.ok(pid > 0, "child pid should have been captured")
  let alive = false
  try {
    process.kill(pid, 0)
    alive = true
  } catch {
    alive = false
  }
  assert.equal(alive, false, "stubborn child should have been SIGKILLed after the grace window")
})

test("SIGKILL escalation gives surviving process-group members the full grace window", {
  timeout: 15_000,
}, async (t) => {
  if (process.platform === "win32") return
  const cwd = await tempDir(t, "openchatx-bash-grace-")
  const heartbeat = join(cwd, "heartbeat.log")

  const server = new McpServer({ name: "bash-grace-test", version: "1.0.0" })
  const client = new Client({ name: "bash-grace-client", version: "1.0.0" })
  registerBashTool(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))

  // The shell dies on SIGTERM, but a descendant in the same process group
  // ignores SIGTERM and keeps ticking. It must not be SIGKILLed the moment the
  // shell exits: it gets the full grace window and is reclaimed afterwards.
  const command = [
    `( trap '' TERM; while true; do echo tick >> "${heartbeat}"; sleep 0.2; done ) >/dev/null 2>&1 &`,
    "while true; do sleep 0.2; done",
  ].join("; ")
  const result = await client.callTool({
    name: "bash",
    arguments: { command, workdir: cwd, timeout_ms: 300 },
  })
  assert.equal(result.isError, undefined)
  assert.equal((result.structuredContent as { timed_out?: boolean }).timed_out, true)

  const lines = async () => {
    const content = await readFile(heartbeat, "utf8").catch(() => "")
    return content ? content.trim().split("\n").length : 0
  }
  const initial = await lines()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const duringGrace = await lines()
  assert.ok(
    duringGrace > initial,
    "descendant should stay alive during the grace window instead of being killed with the shell"
  )

  // After the 2s grace the group is force-killed, so the ticks stop.
  await new Promise((resolve) => setTimeout(resolve, 2200))
  const afterGrace = await lines()
  await new Promise((resolve) => setTimeout(resolve, 600))
  const finalLines = await lines()
  assert.equal(finalLines, afterGrace, "descendant should be reclaimed after the grace window")
})

async function waitForJobOutput(jobs: JobManager, pattern: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [job] = await jobs.list()
    if (job) {
      const log = await jobs.readLogFrom(job.id, 0, 1024 * 1024)
      if (pattern.test(log.output)) return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for durable job output.")
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for bash test condition.")
}
