import { readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, normalize, resolve, sep } from "node:path"

/**
 * Directory browsing for the "new session" sheet. It is served by the host
 * itself so choosing a directory keeps working while opencode is restarting,
 * and it is always rooted at the browse root (the home directory by default):
 * parents above that root are never listed or accepted.
 */
export type DirectoryEntry = {
  name: string
  path: string
  /** Path relative to home, e.g. "code/app". Empty at home. */
  relative: string
}

export type DirectoryListing = {
  home: string
  path: string
  relative: string
  entries: DirectoryEntry[]
}

export type DirectoryCheck = {
  valid: boolean
  directory: boolean
  path?: string
  relative?: string
  error?: string
}

export function homeDirectory(): string {
  return normalize(homedir())
}

/** Root the phone may browse: the user's home directory unless pinned. */
export function browseRoot(): string {
  const override = process.env.OCREMOTE_BROWSE_ROOT?.trim()
  return normalize(override ? override : homedir())
}

/** Resolves `input` (absolute or relative to home) and proves it stays inside home. */
export function resolveUnderHome(input: string, home = browseRoot()): { path: string; relative: string } {
  const root = resolve(home)
  const raw = input.trim()
  if (raw.includes("\0")) throw new DirectoryError("路径包含非法字符")

  let candidate: string
  if (!raw) candidate = root
  else if (raw === "~" || raw.startsWith("~/")) candidate = resolve(root, raw.slice(2))
  else if (isAbsolute(raw)) candidate = resolve(raw)
  else candidate = resolve(root, raw)

  const relative = relativeToHome(candidate, root)
  if (relative === undefined) throw new DirectoryError(`只能选择家目录 ${root} 内的目录`)
  return { path: candidate, relative }
}

export function relativeToHome(path: string, home = browseRoot()): string | undefined {
  const root = resolve(home)
  const target = resolve(path)
  if (target === root) return ""
  const prefix = root.endsWith(sep) ? root : root + sep
  if (!target.startsWith(prefix)) return undefined
  return target.slice(prefix.length)
}

export class DirectoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DirectoryError"
  }
}

/** Lists sub-directories only; files are not valid session locations. */
export async function listDirectories(input: string, home = browseRoot()): Promise<DirectoryListing> {
  const { path, relative } = resolveUnderHome(input, home)
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch {
    throw new DirectoryError(`目录不存在：${path}`)
  }
  if (!info.isDirectory()) throw new DirectoryError(`不是目录：${path}`)

  const entries: DirectoryEntry[] = []
  const dirents = await readdir(path, { withFileTypes: true })
  for (const dirent of dirents) {
    if (dirent.name === "." || dirent.name === "..") continue
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
    const child = join(path, dirent.name)
    // A symlink may point outside home; skip it rather than expose it.
    const childRelative = relativeToHome(child, home)
    if (childRelative === undefined) continue
    if (dirent.isSymbolicLink() && !(await linkStaysInside(child, home))) continue
    entries.push({ name: dirent.name, path: child, relative: childRelative })
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"))
  return { home: resolve(home), path, relative, entries }
}

export async function checkDirectory(input: string, home = browseRoot()): Promise<DirectoryCheck> {
  let resolved: { path: string; relative: string }
  try {
    resolved = resolveUnderHome(input, home)
  } catch (error) {
    return { valid: false, directory: false, error: error instanceof Error ? error.message : "无效路径" }
  }
  try {
    const info = await stat(resolved.path)
    if (!info.isDirectory()) {
      return {
        valid: false,
        directory: false,
        path: resolved.path,
        relative: resolved.relative,
        error: "这是一个文件，请选择目录",
      }
    }
    // Canonicalize so ".." cannot escape through a symlink.
    const canonical = await realpath(resolved.path)
    if (relativeToHome(canonical, home) === undefined) {
      return { valid: false, directory: false, path: resolved.path, error: "只能选择家目录内的目录" }
    }
    return { valid: true, directory: true, path: canonical, relative: relativeToHome(canonical, home) ?? "" }
  } catch {
    return {
      valid: false,
      directory: false,
      path: resolved.path,
      relative: resolved.relative,
      error: "目录不存在",
    }
  }
}

export function parseDirectoryPath(query: string): string {
  // `?path=<abs>`; the value is URL-encoded by the phone.
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query)
  return params.get("path") ?? ""
}

/** True when a symlink resolves to a directory that is still inside home. */
async function linkStaysInside(path: string, home: string): Promise<boolean> {
  try {
    const canonical = await realpath(path)
    const info = await stat(canonical)
    return info.isDirectory() && relativeToHome(canonical, home) !== undefined
  } catch {
    return false
  }
}
