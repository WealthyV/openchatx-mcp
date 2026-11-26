import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { createRefresh } from "../ui/src/lib/refresh.js"

test("session refresh coalesces events and discards reads invalidated by a deletion", async () => {
  const loads: { signal: AbortSignal; resolve: (value: string) => void }[] = []
  const applied: string[] = []
  const errors: string[] = []
  const request = createRefresh<string>(
    (signal) => new Promise((resolve) => loads.push({ signal, resolve })),
    (value) => applied.push(value),
    (error) => errors.push(error)
  )
  try {
    request.refresh()
    request.refresh()
    request.refresh(true)
    assert.equal(loads.length, 1)
    assert.equal(loads[0]?.signal.aborted, true)
    loads[0]?.resolve("stale session")
    await setImmediate()
    assert.deepEqual(applied, [])
    assert.equal(loads.length, 2)
    loads[1]?.resolve("current sessions")
    await setImmediate()
    assert.deepEqual(applied, ["current sessions"])
    assert.deepEqual(errors, [])
    request.refresh()
    request.dispose()
    loads[2]?.resolve("unmounted detail")
    await setImmediate()
    assert.deepEqual(applied, ["current sessions"])
  } finally {
    request.dispose()
  }
})

test("session refresh recovers after a failed request", async () => {
  let attempt = 0
  const applied: string[] = []
  const errors: string[] = []
  const request = createRefresh(
    async () => {
      if (++attempt === 1) throw new Error("disconnected")
      return "reconnected"
    },
    (value) => applied.push(value),
    (error) => errors.push(error)
  )
  try {
    request.refresh()
    await setImmediate()
    assert.deepEqual(errors, ["disconnected"])
    request.refresh()
    await setImmediate()
    assert.deepEqual(applied, ["reconnected"])
  } finally {
    request.dispose()
  }
})
