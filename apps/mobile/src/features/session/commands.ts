import type { TranslateKey } from "@/i18n"

export type CoreCommandAction =
  | "models"
  | "agents"
  | "mcps"
  | "skills"
  | "variants"
  | "sessions"
  | "new"
  | "compact"
  | "status"
  | "help"
  | "diff"
  | "stop"

export type CoreCommandSpec = {
  name: string
  aliases: string[]
  action: CoreCommandAction
  descriptionKey: TranslateKey
  category: "session" | "agent" | "system"
}

/**
 * Local commands mirrored from the OpenCode 2 TUI. Anything that needs a
 * terminal, editor, worktree manager or desktop-only surface belongs in the
 * unavailable list instead.
 */
export const CORE_COMMANDS: CoreCommandSpec[] = [
  { name: "models", aliases: ["model"], action: "models", descriptionKey: "commandModels", category: "agent" },
  { name: "agents", aliases: ["agent"], action: "agents", descriptionKey: "commandAgents", category: "agent" },
  { name: "mcps", aliases: ["mcp"], action: "mcps", descriptionKey: "commandMcps", category: "agent" },
  { name: "skills", aliases: ["skill"], action: "skills", descriptionKey: "commandSkills", category: "agent" },
  {
    name: "variants",
    aliases: ["variant", "thinking", "effort", "reasoning"],
    action: "variants",
    descriptionKey: "commandVariants",
    category: "agent",
  },
  {
    name: "sessions",
    aliases: ["resume", "continue"],
    action: "sessions",
    descriptionKey: "commandSessions",
    category: "session",
  },
  { name: "new", aliases: [], action: "new", descriptionKey: "commandNew", category: "session" },
  { name: "compact", aliases: [], action: "compact", descriptionKey: "commandCompact", category: "session" },
  { name: "status", aliases: [], action: "status", descriptionKey: "commandStatus", category: "session" },
  { name: "diff", aliases: [], action: "diff", descriptionKey: "commandDiff", category: "session" },
  { name: "stop", aliases: [], action: "stop", descriptionKey: "commandStop", category: "session" },
  { name: "help", aliases: [], action: "help", descriptionKey: "commandHelp", category: "system" },
]

/** TUI commands that are shown greyed out instead of being sent to the server. */
export const UNAVAILABLE_COMMANDS = [
  "editor",
  "worktrees",
  "rename",
  "timeline",
  "fork",
  "undo",
  "redo",
  "copy",
  "export",
  "terminal",
  "cd",
  "clear",
  "open",
  "projects",
  "project",
  "usage",
  "connect",
  "highlights",
  "settings",
  "update",
  "pair",
  "web",
  "restart",
  "reload",
  "debug",
  "themes",
  "exit",
  "quit",
  "q",
  "btw",
  "plugins",
  "stats",
] as const

const byAlias = new Map<string, CoreCommandSpec>()
for (const command of CORE_COMMANDS) {
  byAlias.set(command.name, command)
  for (const alias of command.aliases) byAlias.set(alias, command)
}

export function findCoreCommand(name: string): CoreCommandSpec | undefined {
  return byAlias.get(name)
}

const unavailable = new Set<string>(UNAVAILABLE_COMMANDS)

export function isUnavailableCommand(name: string): boolean {
  return unavailable.has(name)
}
