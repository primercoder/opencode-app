import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * User-level autostart integration. The host is a standalone background daemon
 * that must keep running whether or not opencode is up, so it is installed as
 * a per-user service instead of being tied to an opencode session.
 */
export type ServiceKind = "systemd" | "launchd" | "unsupported"

export type ServiceInfo = {
  kind: ServiceKind
  path?: string
  installed: boolean
  /** Commands the user can run to enable/disable autostart. */
  enableCommand?: string
  disableCommand?: string
  statusCommand?: string
  logCommand?: string
}

export function serviceKind(): ServiceKind {
  if (process.platform === "linux") return "systemd"
  if (process.platform === "darwin") return "launchd"
  return "unsupported"
}

export function systemdUnitPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(configHome, "systemd", "user", "ocremote.service")
}

export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "app.ocremote.host.plist")
}

export function serviceCommands(kind: ServiceKind = serviceKind()): Pick<
  ServiceInfo,
  "enableCommand" | "disableCommand" | "statusCommand" | "logCommand"
> {
  if (kind === "systemd") {
    return {
      enableCommand: "systemctl --user daemon-reload && systemctl --user enable --now ocremote.service",
      disableCommand: "systemctl --user disable --now ocremote.service",
      statusCommand: "systemctl --user status ocremote.service",
      logCommand: "journalctl --user -u ocremote.service -f",
    }
  }
  if (kind === "launchd") {
    return {
      enableCommand: "launchctl load -w ~/Library/LaunchAgents/app.ocremote.host.plist",
      disableCommand: "launchctl unload -w ~/Library/LaunchAgents/app.ocremote.host.plist",
      statusCommand: "launchctl list | grep app.ocremote.host",
      logCommand: "tail -f ~/.local/state/ocremote/host.log",
    }
  }
  return {}
}

export async function serviceInfo(): Promise<ServiceInfo> {
  const kind = serviceKind()
  const commands = serviceCommands(kind)
  if (kind === "systemd") {
    const path = systemdUnitPath()
    return { kind, path, installed: await exists(path), ...commands }
  }
  if (kind === "launchd") {
    const path = launchdPlistPath()
    return { kind, path, installed: await exists(path), ...commands }
  }
  return { kind, installed: false, ...commands }
}

/** Writes the autostart unit. It does not enable it; the enable command does. */
export async function installService(input: {
  command: string[]
  cwd: string
  env?: Record<string, string>
}): Promise<ServiceInfo> {
  const kind = serviceKind()
  const commands = serviceCommands(kind)
  if (kind === "systemd") {
    const path = systemdUnitPath()
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, systemdUnit(input), { mode: 0o644 })
    return { kind, path, installed: true, ...commands }
  }
  if (kind === "launchd") {
    const path = launchdPlistPath()
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, launchdPlist(input), { mode: 0o644 })
    return { kind, path, installed: true, ...commands }
  }
  throw new Error(`autostart is not supported on ${process.platform}; run "ocremote start" from your own supervisor`)
}

export async function uninstallService(): Promise<ServiceInfo> {
  const kind = serviceKind()
  const commands = serviceCommands(kind)
  if (kind === "systemd") {
    const path = systemdUnitPath()
    await rm(path, { force: true })
    return { kind, path, installed: false, ...commands }
  }
  if (kind === "launchd") {
    const path = launchdPlistPath()
    await rm(path, { force: true })
    return { kind, path, installed: false, ...commands }
  }
  return { kind, installed: false, ...commands }
}

function systemdUnit(input: { command: string[]; cwd: string; env?: Record<string, string> }): string {
  const exec = input.command.map(quoteSystemd).join(" ")
  const envLines = Object.entries(input.env ?? {}).map(([key, value]) => `Environment=${quoteSystemd(`${key}=${value}`)}`)
  return `[Unit]
Description=OC Remote host (encrypted remote access for opencode)
Documentation=https://primercoder.github.io/opencode-app/
After=network-online.target
# Intentionally not ordered after opencode: the host runs on its own and
# connects to opencode whenever it becomes available.
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${quoteSystemd(input.cwd)}
ExecStart=${exec}
# --foreground keeps systemd as the supervisor instead of double-forking.
Restart=always
RestartSec=3
${envLines.length > 0 ? envLines.join("\n") + "\n" : ""}
[Install]
WantedBy=default.target
`
}

function launchdPlist(input: { command: string[]; cwd: string; env?: Record<string, string> }): string {
  const args = input.command.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n")
  const env = Object.entries(input.env ?? {})
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>app.ocremote.host</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(input.cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${env ? `  <key>EnvironmentVariables</key>\n  <dict>\n${env}\n  </dict>\n` : ""}</dict>
</plist>
`
}

function quoteSystemd(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) return value
  return `"${value.replace(/(["\\])/gu, "\\$1")}"`
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
