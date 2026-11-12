import { describe, expect, test } from "bun:test"
import { OpencodeClient } from "../src/opencode/client.ts"
import type { HostRuntime } from "../src/transport/hostRuntime.ts"

type Call = { method: string; path: string; body?: string; headers?: Record<string, string> }

function client(body = ""): { client: OpencodeClient; calls: Call[] } {
  const calls: Call[] = []
  const runtime = {
    async request(input: Call) {
      calls.push(input)
      return { status: 200, headers: {}, body }
    },
  } as unknown as HostRuntime
  return { client: new OpencodeClient(runtime), calls }
}

describe("OpencodeClient", () => {
  test("lists newest sessions first and encodes search", async () => {
    const { client: api, calls } = client('{"data":[],"cursor":"next"}')
    await api.listSessions({ limit: 20, order: "desc", search: "auth flow" })
    expect(calls[0]?.path).toBe("/api/session?limit=20&order=desc&search=auth+flow")
  })

  test("sends a prompt body", async () => {
    const { client: api, calls } = client()
    await api.prompt("ses_1", "hello")
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/session/ses_1/prompt",
      body: '{"text":"hello"}',
      headers: { "content-type": "application/json" },
    })
  })

  test("lists messages with order or with a cursor, never both", async () => {
    const { client: api, calls } = client('{"data":[],"cursor":{"previous":"p","next":"n"}}')
    const first = await api.listMessages("ses_1", { limit: 50, order: "desc" })
    expect(first.cursor).toEqual({ previous: "p", next: "n" })
    await api.listMessages("ses_1", { limit: 50, cursor: "abc" })
    expect(calls[0]?.path).toBe("/api/session/ses_1/message?limit=50&order=desc")
    expect(calls[1]?.path).toBe("/api/session/ses_1/message?limit=50&cursor=abc")
  })

  test("lists projects and creates a session in a directory", async () => {
    const { client: api, calls } = client('[{"id":"prj_1","canonical":"/work/a"}]')
    const projects = await api.listProjects()
    expect(projects[0]?.canonical).toBe("/work/a")
    await api.createSession({ location: { directory: "/work/a" } })
    expect(calls[0]?.path).toBe("/api/project?archived=false")
    expect(calls[1]).toMatchObject({ path: "/api/session", body: '{"location":{"directory":"/work/a"}}' })
  })

  test("loads catalogs with a directory and switches agent/model", async () => {
    const { client: api, calls } = client('{"data":[]}')
    await api.listAgents("/work/project")
    await api.listModels("/work/project")
    await api.switchAgent("ses_1", "plan")
    await api.switchModel("ses_1", { id: "claude", providerID: "anthropic", variant: "high" })
    expect(calls[0]?.path).toBe("/api/agent?location%5Bdirectory%5D=%2Fwork%2Fproject")
    expect(calls[1]?.path).toBe("/api/model?types=chat&location%5Bdirectory%5D=%2Fwork%2Fproject")
    expect(calls[2]).toMatchObject({ path: "/api/session/ses_1/agent", body: '{"agent":"plan"}' })
    expect(calls[3]).toMatchObject({
      path: "/api/session/ses_1/model",
      body: '{"model":{"id":"claude","providerID":"anthropic","variant":"high"}}',
    })
  })

  test("lists and reads project files", async () => {
    const { client: api, calls } = client('{"data":[]}')
    await api.listFiles("/work/project", "src")
    await api.readFile("/work/project", "src/a b.ts")
    expect(calls[0]?.path).toContain("path=src")
    expect(calls[1]?.path).toBe("/api/fs/read/src/a%20b.ts?location%5Bdirectory%5D=%2Fwork%2Fproject")
  })

  test("sends prompt files and metadata", async () => {
    const { client: api, calls } = client()
    await api.prompt("ses_1", {
      text: "comment",
      files: [{ uri: "file:///work/a.ts?start=1&end=2", mime: "text/plain", name: "a.ts" }],
      metadata: { comments: [{ path: "a.ts" }] },
    })
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      text: "comment",
      files: [{ uri: "file:///work/a.ts?start=1&end=2", mime: "text/plain", name: "a.ts" }],
      metadata: { comments: [{ path: "a.ts" }] },
    })
  })

  test("loads the session diff", async () => {
    const { client: api, calls } = client('{"data":[{"file":"a.ts","patch":"+x","additions":1,"deletions":0,"status":"modified"}]}')
    const diffs = await api.sessionDiff("ses_1")
    expect(calls[0]?.path).toBe("/api/session/ses_1/diff")
    expect(diffs[0]?.file).toBe("a.ts")
  })

  test("replies to permissions and forms", async () => {
    const { client: api, calls } = client()
    await api.replyPermission("ses_1", "per_1", "reject", "no")
    await api.replyForm("ses_1", "frm_1", { approach: "minimal", runTests: false })
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/session/ses_1/permission/per_1/reply",
      body: '{"decision":"reject","message":"no"}',
    })
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: "/api/session/ses_1/form/frm_1/reply",
      body: '{"answer":{"approach":"minimal","runTests":false}}',
    })
  })
})
