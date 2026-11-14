import { useTheme } from "@/theme"
import Svg, { Path, Text as SvgText } from "react-native-svg"

type Spec = {
  label: string
  color: string
  text?: string
}

const DEFAULT: Spec = { label: "FILE", color: "#8A94A3" }

const EXTENSIONS: Record<string, Spec> = {
  ts: { label: "TS", color: "#3178C6" },
  tsx: { label: "TSX", color: "#3178C6" },
  js: { label: "JS", color: "#F7DF1E", text: "#1B1B1B" },
  jsx: { label: "JSX", color: "#F7DF1E", text: "#1B1B1B" },
  mjs: { label: "JS", color: "#F7DF1E", text: "#1B1B1B" },
  cjs: { label: "JS", color: "#F7DF1E", text: "#1B1B1B" },
  py: { label: "PY", color: "#3776AB" },
  pyi: { label: "PY", color: "#3776AB" },
  go: { label: "GO", color: "#00ADD8", text: "#062F3A" },
  rs: { label: "RS", color: "#DEA584", text: "#2C1B12" },
  java: { label: "JV", color: "#B07219" },
  kt: { label: "KT", color: "#A97BFF" },
  kts: { label: "KT", color: "#A97BFF" },
  swift: { label: "SW", color: "#F05138" },
  rb: { label: "RB", color: "#CC342D" },
  php: { label: "PHP", color: "#777BB4" },
  c: { label: "C", color: "#5C6BC0" },
  h: { label: "H", color: "#5C6BC0" },
  cpp: { label: "C++", color: "#00599C" },
  cc: { label: "C++", color: "#00599C" },
  cxx: { label: "C++", color: "#00599C" },
  hpp: { label: "H++", color: "#00599C" },
  cs: { label: "C#", color: "#68217A" },
  html: { label: "<>", color: "#E34F26" },
  htm: { label: "<>", color: "#E34F26" },
  css: { label: "CSS", color: "#1572B6" },
  scss: { label: "SC", color: "#CD6799" },
  sass: { label: "SA", color: "#CD6799" },
  less: { label: "LE", color: "#1D365D" },
  json: { label: "{}", color: "#CBCB41", text: "#2A2A12" },
  jsonc: { label: "{}", color: "#CBCB41", text: "#2A2A12" },
  json5: { label: "{}", color: "#CBCB41", text: "#2A2A12" },
  md: { label: "MD", color: "#519ABA" },
  mdx: { label: "MDX", color: "#519ABA" },
  yaml: { label: "YML", color: "#CB171E" },
  yml: { label: "YML", color: "#CB171E" },
  toml: { label: "T", color: "#9C4121" },
  xml: { label: "XML", color: "#F1662A" },
  sh: { label: ">_", color: "#4EAA25" },
  bash: { label: ">_", color: "#4EAA25" },
  zsh: { label: ">_", color: "#4EAA25" },
  fish: { label: ">_", color: "#4EAA25" },
  sql: { label: "SQL", color: "#336791" },
  txt: { label: "TXT", color: "#8A94A3" },
  log: { label: "LOG", color: "#8A94A3" },
  lock: { label: "LOCK", color: "#8A94A3" },
  env: { label: "ENV", color: "#ECD53F", text: "#1B1B1B" },
  png: { label: "IMG", color: "#26A69A" },
  jpg: { label: "IMG", color: "#26A69A" },
  jpeg: { label: "IMG", color: "#26A69A" },
  gif: { label: "IMG", color: "#26A69A" },
  webp: { label: "IMG", color: "#26A69A" },
  bmp: { label: "IMG", color: "#26A69A" },
  ico: { label: "IMG", color: "#26A69A" },
  avif: { label: "IMG", color: "#26A69A" },
  svg: { label: "SVG", color: "#FFB13B", text: "#3A2600" },
  pdf: { label: "PDF", color: "#E53935" },
  zip: { label: "ZIP", color: "#FFB300", text: "#3A2A00" },
  tar: { label: "TAR", color: "#FFB300", text: "#3A2A00" },
  gz: { label: "GZ", color: "#FFB300", text: "#3A2A00" },
  tgz: { label: "TGZ", color: "#FFB300", text: "#3A2A00" },
  bz2: { label: "BZ2", color: "#FFB300", text: "#3A2A00" },
  xz: { label: "XZ", color: "#FFB300", text: "#3A2A00" },
  zst: { label: "ZST", color: "#FFB300", text: "#3A2A00" },
  "7z": { label: "7Z", color: "#FFB300", text: "#3A2A00" },
  rar: { label: "RAR", color: "#FFB300", text: "#3A2A00" },
  mp3: { label: "AUD", color: "#AB47BC" },
  wav: { label: "AUD", color: "#AB47BC" },
  ogg: { label: "AUD", color: "#AB47BC" },
  flac: { label: "AUD", color: "#AB47BC" },
  m4a: { label: "AUD", color: "#AB47BC" },
  mp4: { label: "VID", color: "#7E57C2" },
  mov: { label: "VID", color: "#7E57C2" },
  webm: { label: "VID", color: "#7E57C2" },
  mkv: { label: "VID", color: "#7E57C2" },
  woff: { label: "FNT", color: "#607D8B" },
  woff2: { label: "FNT", color: "#607D8B" },
  ttf: { label: "FNT", color: "#607D8B" },
  otf: { label: "FNT", color: "#607D8B" },
  wasm: { label: "WASM", color: "#654FF0" },
  ipynb: { label: "NB", color: "#F37726" },
  map: { label: "MAP", color: "#8A94A3" },
}

const FILES: Record<string, Spec> = {
  dockerfile: { label: "DKR", color: "#2496ED" },
  makefile: { label: "MK", color: "#6D8086" },
  ".gitignore": { label: "GIT", color: "#F14E32" },
  ".gitattributes": { label: "GIT", color: "#F14E32" },
  ".gitmodules": { label: "GIT", color: "#F14E32" },
  ".env": { label: "ENV", color: "#ECD53F", text: "#1B1B1B" },
  "package.json": { label: "{}", color: "#CBCB41", text: "#2A2A12" },
  "tsconfig.json": { label: "TS", color: "#3178C6" },
  "license": { label: "LIC", color: "#8A94A3" },
  "readme.md": { label: "MD", color: "#519ABA" },
}

function specFor(name: string): Spec {
  const base = name.split("/").filter(Boolean).pop()?.toLowerCase() ?? ""
  const direct = FILES[base]
  if (direct) return direct
  const extension = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : ""
  return EXTENSIONS[extension] ?? DEFAULT
}

/**
 * A compact file-type glyph: a document silhouette filled with the language or
 * media colour plus a short extension label. Directories use a filled folder.
 */
export function FileTypeIcon({
  name,
  directory = false,
  size = 24,
}: {
  name: string
  directory?: boolean
  size?: number
}) {
  const { colors } = useTheme()
  if (directory) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path
          d="M2.8 7.2A2.7 2.7 0 0 1 5.5 4.5h3.7l2 2h7.3a2.7 2.7 0 0 1 2.7 2.7v8.1a2.7 2.7 0 0 1-2.7 2.7h-13a2.7 2.7 0 0 1-2.7-2.7z"
          fill={colors.accent}
          opacity={0.16}
        />
        <Path
          d="M2.8 7.2A2.7 2.7 0 0 1 5.5 4.5h3.7l2 2h7.3a2.7 2.7 0 0 1 2.7 2.7v8.1a2.7 2.7 0 0 1-2.7 2.7h-13a2.7 2.7 0 0 1-2.7-2.7z"
          fill="none"
          stroke={colors.accent}
          strokeWidth={1.7}
          strokeLinejoin="round"
        />
      </Svg>
    )
  }

  const spec = specFor(name)
  const label = spec.label
  const fontSize = label.length > 2 ? 5.2 : label.length > 1 ? 6.4 : 7.6
  return (
    <Svg width={size} height={size * 1.14} viewBox="0 0 24 28">
      <Path
        d="M3.5 2.2A1.7 1.7 0 0 1 5.2.5h10.4l4.9 4.9v20.4a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z"
        fill={spec.color}
      />
      <Path d="M15.6.5 20.5 5.4h-3.2a1.7 1.7 0 0 1-1.7-1.7z" fill="#FFFFFF" opacity={0.38} />
      <SvgText
        x="11.8"
        y="19.8"
        fill={spec.text ?? "#FFFFFF"}
        fontSize={fontSize}
        fontWeight="700"
        textAnchor="middle"
      >
        {label}
      </SvgText>
    </Svg>
  )
}
