import { useCallback, useEffect, useRef, useState } from "react"

import { deleteAgent, fetchAgents, subscribeToAgents } from "../lib/api"
import { createRefresh } from "../lib/refresh"
import type { Agent } from "../types"
import { upsertAgentByActivity } from "./agent-order.js"

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const refreshAgents = useRef<(invalidate?: boolean) => void>(() => undefined)

  useEffect(() => {
    let changes = new Map<string, Agent | undefined>()
    const request = createRefresh(
      async (signal) => {
        const duringRead = new Map<string, Agent | undefined>()
        changes = duringRead
        return { snapshot: await fetchAgents(signal), duringRead }
      },
      ({ snapshot, duringRead }) => {
        let merged = snapshot
        for (const [id, agent] of duringRead) {
          merged = agent
            ? upsertAgentByActivity(merged, agent)
            : merged.filter((item) => item.id !== id)
        }
        setAgents(merged)
        setError(undefined)
        setLoading(false)
      },
      (message) => {
        setError(message)
        setLoading(false)
      }
    )
    refreshAgents.current = request.refresh

    const unsubscribe = subscribeToAgents(
      (event) => {
        if (event.type === "agent_removed") changes.set(event.agentId, undefined)
        else changes.set(event.agent.id, event.agent)
        setAgents((current) => {
          if (event.type === "agent_removed") {
            return current.filter((item) => item.id !== event.agentId)
          }
          return upsertAgentByActivity(current, event.agent)
        })
      },
      (isConnected) => {
        setConnected(isConnected)
        if (isConnected) request.refresh()
      }
    )
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") request.refresh()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    request.refresh()
    // SSE provides immediate updates; polling reconciles missed events and
    // silently disconnected streams so evicted sessions cannot remain overnight.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") request.refresh()
    }, 10_000)

    return () => {
      request.dispose()
      refreshAgents.current = () => undefined
      unsubscribe()
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.clearInterval(timer)
    }
  }, [])

  const removeAgent = useCallback(async (agentId: string) => {
    await deleteAgent(agentId)
    refreshAgents.current(true)
    setAgents((current) => current.filter((agent) => agent.id !== agentId))
  }, [])

  return { agents, connected, loading, error, removeAgent }
}
