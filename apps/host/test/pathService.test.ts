import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkDirectory,
  listDirectories,
  relativeToHome,
  resolveUnderHome,
} from "../src/pathService.ts"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ocremote-home-"))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, "code", "project"), { recursive: true })
  await mkdir(join(home, "notes"), { recursive: true })
  await writeFile(join(home, "file.txt"), "x")
  return home
}

describe("directory service", () => {
  test("roots everything at home and rejects paths above it", async () => {
    const home = await fixture()
    expect(resolveUnderHome("", home)).toEqual({ path: home, relative: "" })
    expect(resolveUnderHome("code/project", home)).toEqual({
      path: join(home, "code", "project"),
      relative: "code/project",
    })
    expect(resolveUnderHome("~/code", home)).toEqual({ path: join(home, "code"), relative: "code" })
    expect(() => resolveUnderHome("/etc", home)).toThrow(/家目录/u)
    expect(() => resolveUnderHome("../outside", home)).toThrow(/家目录/u)
    expect(relativeToHome(home, home)).toBe("")
    expect(relativeToHome(join(home, "a"), home)).toBe("a")
    expect(relativeToHome(`${home}-other`, home)).toBeUndefined()
  })

  test("lists only directories and skips symlinks that leave home", async () => {
    const home = await fixture()
    const outside = await mkdtemp(join(tmpdir(), "ocremote-outside-"))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    await symlink(outside, join(home, "escape"))

    const listing = await listDirectories("", home)
    expect(listing.path).toBe(home)
    expect(listing.relative).toBe("")
    expect(listing.entries.map((entry) => entry.name)).toEqual(["code", "notes"])
    expect(listing.entries.some((entry) => entry.name === "file.txt")).toBe(false)
  })

  test("navigates into subdirectories and reports a relative path", async () => {
    const home = await fixture()
    const listing = await listDirectories(join(home, "code"), home)
    expect(listing.relative).toBe("code")
    expect(listing.entries).toEqual([
      { name: "project", path: join(home, "code", "project"), relative: "code/project" },
    ])
  })

  test("rejects missing directories and files", async () => {
    const home = await fixture()
    await expect(listDirectories("nope", home)).rejects.toThrow(/不存在/u)

    const missing = await checkDirectory("nope", home)
    expect(missing.valid).toBe(false)
    expect(missing.error).toContain("不存在")

    const file = await checkDirectory("file.txt", home)
    expect(file.valid).toBe(false)
    expect(file.directory).toBe(false)
  })

  test("accepts an existing directory and returns its canonical path", async () => {
    const home = await fixture()
    const ok = await checkDirectory("code/project", home)
    expect(ok.valid).toBe(true)
    expect(ok.directory).toBe(true)
    expect(ok.relative).toBe("code/project")

    const outside = await checkDirectory("/etc", home)
    expect(outside.valid).toBe(false)
  })
})
