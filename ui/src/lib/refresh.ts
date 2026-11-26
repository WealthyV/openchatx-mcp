// A single in-flight read with one queued refresh. Mutation invalidations and
// unmounts cancel obsolete reads; late responses cannot resurrect old state.
export function createRefresh<T>(
  load: (signal: AbortSignal) => Promise<T>,
  apply: (value: T) => void,
  fail: (message: string) => void
) {
  let disposed = false
  let pending = false
  let version = 0
  let controller: AbortController | undefined
  function refresh(invalidate = false) {
    if (disposed) return
    if (invalidate) version += 1
    if (controller) {
      pending = true
      if (invalidate) controller.abort()
      return
    }
    const request = new AbortController()
    controller = request
    const currentVersion = version
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      request.abort()
    }, 15_000)
    void load(request.signal)
      .then((value) => {
        if (!disposed && currentVersion === version) apply(value)
      })
      .catch((cause) => {
        if (!disposed && currentVersion === version)
          fail(
            timedOut
              ? "Dashboard request timed out (15 seconds)."
              : cause instanceof Error
                ? cause.message
                : String(cause)
          )
      })
      .finally(() => {
        clearTimeout(timer)
        controller = undefined
        if (pending && !disposed) {
          pending = false
          refresh()
        }
      })
  }
  return {
    refresh,
    dispose() {
      disposed = true
      controller?.abort()
    },
  }
}
