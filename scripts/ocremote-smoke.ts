/**
 * Read-only smoke test against the locally running opencode 2.x service.
 *
 * It starts a temporary ocremote host, pairs a device over the encrypted LAN
 * transport, and exercises the same API paths the Android app uses. It never
 * creates a session or sends a prompt.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { startHost } from "../apps/host/src/server.ts"
import { OpencodeClient } from "../apps/mobile/src/opencode/client.ts"
import { HostRuntime } from "../apps/mobile/src/transport/hostRuntime.ts"

const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
const registration = join(stateHome, "opencode", "service.json")
const service = JSON.parse(await readFile(registration, "utf8")) as {
  url?: string
  password?: string
  version?: string
}

if (!service.url || !service.password) throw new Error(`missing url/password in ${registration}`)
console.log(`opencode ${service.version ?? "unknown"} at ${service.url}`)

const home = await mkdtemp(join(tmpdir(), "ocremote-smoke-"))
const host = await startHost({
  homeDir: home,
  hostname: "127.0.0.1",
  port: 0,
  opencodeUrl: service.url,
  opencodePassword: service.password,
})

const runtime = new HostRuntime({
  hostId: host.identity.hostId,
  hostPublicKey: host.identity.publicKey,
  candidates: [`ws://127.0.0.1:${host.port}/ws`],
  pairCode: await host.issuePairCode(),
  autoReconnect: false,
})

try {
  const session = await runtime.connect()
  console.log(`paired with ${session.host.name}, opencode ${session.opencode.version}`)

  const api = new OpencodeClient(runtime)
  const info = await api.info()
  console.log(`info: ${info.version ?? "?"} on ${info.hostname ?? "?"}`)

  const sessions = await api.listSessions({ limit: 5, order: "desc" })
  console.log(`sessions: ${sessions.data.length}`)

  const projects = await api.listProjects()
  console.log(`projects: ${projects.length}`)

  const directory = sessions.data[0]?.location?.directory ?? projects[0]?.canonical
  if (directory) {
    const [models, agents, files] = await Promise.all([
      api.listModels(directory),
      api.listAgents(directory),
      api.listFiles(directory),
    ])
    console.log(`catalog: ${models.length} models, ${agents.length} agents, ${files.length} root entries`)

    const text = await api.readFile(directory, "package.json").catch(async () => {
      const first = files.find((entry) => entry.type === "file")
      if (!first) throw new Error("no readable file at project root")
      return api.readFile(directory, first.path)
    })
    console.log(`read: ${text.content.length} bytes (${text.contentType ?? "unknown"})`)
  }

  const latest = sessions.data[0]
  if (latest) {
    const [messages, permissions, forms, diff] = await Promise.all([
      api.listMessages(latest.id, { limit: 3, order: "desc" }),
      api.listPermissions(latest.id),
      api.listForms(latest.id),
      api.sessionDiff(latest.id),
    ])
    console.log(
      `session ${latest.id}: ${messages.data.length} recent messages, ${permissions.length} permissions, ${forms.length} forms, ${diff.length} diffs`,
    )
  }

  console.log("smoke ok")
} finally {
  runtime.disconnect()
  await host.close()
  await rm(home, { recursive: true, force: true })
}
