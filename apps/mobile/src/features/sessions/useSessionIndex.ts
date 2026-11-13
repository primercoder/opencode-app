import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { OpencodeClient, sessionUpdatedAt, type ProjectInfo, type SessionInfo } from "@/opencode/client"
import { ensureConnection, subscribeHostEvents } from "@/transport/runtimes"

export type SessionGroup = {
  key: string
  name: string
  directory?: string
  sessions: SessionInfo[]
  updatedAt: number
}

export function useSessionIndex(hostId: string | undefined, enabled: boolean) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const loaded = useRef(false)

  const load = useCallback(
    async (options: { silent?: boolean; hard?: boolean } = {}) => {
      if (!hostId) return
      if (options.hard) loaded.current = false
      if (!options.silent) setLoading(!loaded.current)
      if (options.hard) setRefreshing(true)
      setError(null)
      try {
        const runtime = await ensureConnection(hostId)
        const client = new OpencodeClient(runtime)
        const [page, projectList] = await Promise.all([
          client.listSessions({ limit: 200, order: "desc" }),
          client.listProjects().catch(() => []),
        ])
        setSessions(page.data)
        setProjects(projectList)
        loaded.current = true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "failed to load sessions")
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [hostId],
  )

  useEffect(() => {
    if (!enabled || !hostId) return
    void load()
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeHostEvents(hostId, (event) => {
      if (!event.type || !/^(session|message)\./u.test(event.type)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load({ silent: true }), 800)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [enabled, hostId, load])

  const groups = useMemo(() => groupSessions(sessions ?? [], projects), [sessions, projects])

  return {
    sessions,
    projects,
    groups,
    loading,
    refreshing,
    error,
    reload: load,
    refresh: () => load({ silent: true, hard: true }),
  }
}

export function groupSessions(sessions: SessionInfo[], projects: ProjectInfo[]): SessionGroup[] {
  const projectNames = new Map<string, string>()
  for (const project of projects) {
    projectNames.set(project.canonical, project.name?.trim() || basename(project.canonical))
  }

  const byKey = new Map<string, SessionGroup>()
  for (const session of sessions) {
    if (session.parentID) continue
    const directory = session.location?.directory
    const key = directory ?? session.projectID ?? "opencode"
    const existing = byKey.get(key)
    const updatedAt = sessionUpdatedAt(session)
    if (existing) {
      existing.sessions.push(session)
      existing.updatedAt = Math.max(existing.updatedAt, updatedAt)
      continue
    }
    byKey.set(key, {
      key,
      name: (directory ? projectNames.get(directory) : undefined) ?? (directory ? basename(directory) : "opencode"),
      ...(directory ? { directory } : {}),
      sessions: [session],
      updatedAt,
    })
  }

  const groups = [...byKey.values()]
  for (const group of groups) {
    group.sessions.sort((left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left))
  }
  groups.sort((left, right) => right.updatedAt - left.updatedAt)
  return groups
}

export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}
