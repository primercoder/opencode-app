export type FileKind =
  | "directory"
  | "text"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "pdf"
  | "font"
  | "binary"
  | "unknown"

export type FileInfo = {
  kind: FileKind
  previewable: boolean
  language?: string
}

const TEXT: Record<string, string | undefined> = {
  ts: "typescript",
  tsx: "typescriptreact",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  json: "json",
  jsonc: "jsonc",
  json5: "json",
  map: "json",
  md: "markdown",
  mdx: "mdx",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "properties",
  xml: "xml",
  plist: "xml",
  svg: "xml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
  ps1: "powershell",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  txt: "plaintext",
  text: "plaintext",
  log: "plaintext",
  csv: "csv",
  tsv: "tsv",
  lock: "plaintext",
  env: "plaintext",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  lua: "lua",
  r: "r",
  dart: "dart",
  scala: "scala",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  cljs: "clojure",
  elm: "elm",
  sol: "solidity",
  zig: "zig",
  nim: "nim",
  nix: "nix",
  tex: "latex",
  bib: "bibtex",
  diff: "diff",
  patch: "diff",
  ipynb: "json",
}

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tif", "tiff"])
const AUDIO = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"])
const VIDEO = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"])
const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar"])
const FONT = new Set(["woff", "woff2", "ttf", "otf", "eot"])
const BINARY = new Set(["wasm", "exe", "dll", "so", "dylib", "bin", "class", "jar", "pyc", "o", "a", "obj", "lib", "sqlite", "db", "realm"])

function extension(path: string): string {
  const base = path.split("/").filter(Boolean).pop()?.toLowerCase() ?? ""
  return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : ""
}

export function classifyFile(path: string, type: "file" | "directory" = "file"): FileInfo {
  if (type === "directory" || path.endsWith("/")) return { kind: "directory", previewable: false }
  const base = path.split("/").filter(Boolean).pop()?.toLowerCase() ?? ""
  if (base === "dockerfile" || base === "makefile" || base.startsWith(".env")) {
    return { kind: "text", previewable: true, language: "plaintext" }
  }
  if (base === ".gitignore" || base === ".gitattributes" || base === ".gitmodules") {
    return { kind: "text", previewable: true, language: "plaintext" }
  }
  const ext = extension(path)
  if (ext && Object.hasOwn(TEXT, ext)) {
    return { kind: "text", previewable: true, ...(TEXT[ext] ? { language: TEXT[ext] } : {}) }
  }
  if (IMAGE.has(ext)) return { kind: "image", previewable: false }
  if (AUDIO.has(ext)) return { kind: "audio", previewable: false }
  if (VIDEO.has(ext)) return { kind: "video", previewable: false }
  if (ARCHIVE.has(ext)) return { kind: "archive", previewable: false }
  if (FONT.has(ext)) return { kind: "font", previewable: false }
  if (ext === "pdf") return { kind: "pdf", previewable: false }
  if (BINARY.has(ext)) return { kind: "binary", previewable: false }
  return { kind: "unknown", previewable: true }
}

/** Content fallback for unknown extensions; extensions win for known files. */
export function looksBinary(body: string, contentType?: string): boolean {
  if (body.includes("\u0000")) return true
  let suspicious = 0
  for (const character of body) {
    const code = character.codePointAt(0) ?? 0
    if (character === "\uFFFD") suspicious += 1
    else if (code < 0x20 && character !== "\n" && character !== "\r" && character !== "\t" && character !== "\f") suspicious += 1
  }
  if (body.length > 32 && suspicious / body.length > 0.015) return true
  return /^(?:image|audio|video|font)\//u.test(contentType ?? "") && !/svg/iu.test(contentType ?? "")
}
