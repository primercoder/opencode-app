const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "pyi", "go", "rs", "java", "kt", "kts", "swift", "rb", "php",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "fs", "fsx",
  "html", "htm", "xhtml", "css", "scss", "sass", "less", "styl",
  "json", "jsonc", "json5", "geojson", "map",
  "md", "mdx", "markdown", "rst", "adoc",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
  "xml", "plist", "svg", "graphql", "gql",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "proto", "thrift",
  "txt", "text", "log", "csv", "tsv", "lock",
  "env", "gitignore", "gitattributes", "gitmodules", "editorconfig",
  "dockerfile", "makefile", "cmake", "gradle", "groovy",
  "vue", "svelte", "astro", "nix", "lua", "r", "dart", "ex", "exs",
  "clj", "cljs", "scala", "hs", "elm", "sol", "zig", "nim", "v",
  "ipynb", "tex", "bib", "diff", "patch",
])

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tif", "tiff",
  "pdf", "zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar",
  "mp3", "wav", "ogg", "flac", "m4a", "aac", "opus",
  "mp4", "mov", "webm", "mkv", "avi", "m4v",
  "woff", "woff2", "ttf", "otf", "eot",
  "wasm", "exe", "dll", "so", "dylib", "bin", "class", "jar",
  "pyc", "o", "a", "obj", "lib", "sqlite", "db", "realm",
])

const TEXT_MIME = [
  /^text\//u,
  /^application\/(?:json|ld\+json|xml|xhtml\+xml|javascript|ecmascript|typescript|x-sh|x-shellscript|yaml|x-yaml|toml|graphql|sql|x-httpd-php|x-latex|x-tex)/u,
]

/** Map an extension or well-known filename to a text/binary hint, or undefined. */
export function contentKind(path: string): "text" | "binary" | undefined {
  const base = path.split("/").filter(Boolean).pop()?.toLowerCase() ?? ""
  if (base === "dockerfile" || base === "makefile" || base.startsWith(".env")) return "text"
  if (base === ".gitignore" || base === ".gitattributes" || base === ".gitmodules") return "text"
  const extension = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : ""
  if (TEXT_EXTENSIONS.has(extension)) return "text"
  if (BINARY_EXTENSIONS.has(extension)) return "binary"
  return undefined
}

/**
 * Decide whether a downloaded file should be shown as text. File extensions win
 * over server MIME types because common source extensions collide with media
 * types (notably `.ts`, which servers often report as `video/mp2t`).
 */
export function isProbablyBinary(content: string, contentType: string | undefined, path: string): boolean {
  const kind = contentKind(path)
  const textMime = TEXT_MIME.some((pattern) => pattern.test(contentType ?? ""))
  const binaryMime = /^(?:image|audio|video|font)\//u.test(contentType ?? "") && !/svg/iu.test(contentType ?? "")

  if (kind === "binary") return true
  if (hasBinaryMarkers(content)) return true
  if (kind === "text") return false
  if (textMime) return false
  if (binaryMime) return true
  return false
}

function hasBinaryMarkers(content: string): boolean {
  if (content.length === 0) return false
  if (content.includes("\u0000")) return true
  let suspicious = 0
  for (const character of content) {
    const code = character.codePointAt(0) ?? 0
    if (character === "\uFFFD") {
      suspicious += 1
      continue
    }
    if (code < 0x20 && character !== "\n" && character !== "\r" && character !== "\t" && character !== "\f") {
      suspicious += 1
    }
  }
  // Short snippets can legitimately contain a control byte; only flag a file
  // when the suspicious share is material.
  return content.length > 32 && suspicious / content.length > 0.015
}
