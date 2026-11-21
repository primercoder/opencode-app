import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  installService,
  launchdPlistPath,
  serviceCommands,
  serviceInfo,
  systemdUnitPath,
  uninstallService,
} from "../src/service.ts"

const cleanups: Array<() => Promise<void> | void> = []
const original = {
  configHome: process.env.XDG_CONFIG_HOME,
  home: process.env.HOME,
  ocremoteState: process.env.OCREMOTE_STATE_DIR,
}

afterEach(async () => {
  process.env.XDG_CONFIG_HOME = original.configHome
  process.env.HOME = original.home
  if (original.ocremoteState === undefined) delete process.env.OCREMOTE_STATE_DIR
  else process.env.OCREMOTE_STATE_DIR = original.ocremoteState
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe("user-level service", () => {
  test("systemd unit is independent of opencode and does not fork", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "ocremote-xdg-"))
    cleanups.push(() => rm(configHome, { recursive: true, force: true }))
    process.env.XDG_CONFIG_HOME = configHome

    const info = await installService({
      command: ["/usr/bin/bun", "/opt/ocremote/src/index.ts", "start", "--foreground"],
      cwd: "/opt/ocremote",
      env: { OCREMOTE_DAEMON_CHILD: "1" },
    })
    expect(info.kind).toBe("systemd")
    expect(info.installed).toBe(true)
    expect(info.path).toBe(systemdUnitPath())

    const unit = await readFile(systemdUnitPath(), "utf8")
    expect(unit).toContain("ExecStart=/usr/bin/bun /opt/ocremote/src/index.ts start --foreground")
    expect(unit).toContain("WorkingDirectory=/opt/ocremote")
    expect(unit).toContain("Restart=always")
    expect(unit).toContain("WantedBy=default.target")
    expect(unit).toContain("Environment=OCREMOTE_DAEMON_CHILD=1")
    // The host must not be ordered after or require opencode.
    expect(unit).not.toMatch(/Requires=.*opencode/iu)
    expect(unit).not.toMatch(/After=.*opencode/iu)

    const status = await serviceInfo()
    expect(status.installed).toBe(true)

    const removed = await uninstallService()
    expect(removed.installed).toBe(false)
    expect((await serviceInfo()).installed).toBe(false)
  })

  test("enable/disable commands are platform specific and absolute", () => {
    const systemd = serviceCommands("systemd")
    expect(systemd.enableCommand).toContain("systemctl --user enable")
    expect(systemd.disableCommand).toContain("systemctl --user disable")
    expect(systemd.logCommand).toContain("journalctl")

    const launchd = serviceCommands("launchd")
    expect(launchd.enableCommand).toContain("launchctl load")
    expect(launchd.disableCommand).toContain("launchctl unload")

    expect(serviceCommands("unsupported")).toEqual({})
  })

  test("launchd plist path lives in the user LaunchAgents folder", () => {
    expect(launchdPlistPath()).toContain(join("Library", "LaunchAgents"))
  })
})
