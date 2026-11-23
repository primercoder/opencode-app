import Svg, { Circle, Line, Path, Polyline, Rect } from "react-native-svg"

export type IconName =
  | "menu"
  | "settings"
  | "back"
  | "close"
  | "plus"
  | "send"
  | "mic"
  | "stop"
  | "search"
  | "check"
  | "chevronDown"
  | "chevronRight"
  | "server"
  | "terminal"
  | "folder"
  | "message"
  | "diff"
  | "eye"
  | "bell"
  | "moon"
  | "sun"
  | "trash"
  | "lock"
  | "refresh"
  | "globe"
  | "wifi"
  | "sliders"
  | "spark"
  | "comment"
  | "edit"
  | "wrapText"
  | "noWrapText"
  | "arrowUp"
  | "activity"
  | "bolt"
  | "copy"
  | "code"

export function Icon(props: {
  name: IconName
  size?: number
  color?: string
  strokeWidth?: number
}) {
  const size = props.size ?? 22
  const color = props.color ?? "currentColor"
  const width = props.strokeWidth ?? 1.9
  const common = {
    stroke: color,
    strokeWidth: width,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {props.name === "menu" ? (
        <>
          <Line x1="4" y1="7" x2="20" y2="7" {...common} />
          <Line x1="4" y1="12" x2="20" y2="12" {...common} />
          <Line x1="4" y1="17" x2="20" y2="17" {...common} />
        </>
      ) : null}
      {props.name === "settings" || props.name === "sliders" ? (
        <>
          <Line x1="4" y1="7" x2="20" y2="7" {...common} />
          <Circle cx="9" cy="7" r="2" fill={color} stroke="none" />
          <Line x1="4" y1="12" x2="20" y2="12" {...common} />
          <Circle cx="15" cy="12" r="2" fill={color} stroke="none" />
          <Line x1="4" y1="17" x2="20" y2="17" {...common} />
          <Circle cx="11" cy="17" r="2" fill={color} stroke="none" />
        </>
      ) : null}
      {props.name === "back" ? <Polyline points="15 5 8 12 15 19" {...common} /> : null}
      {props.name === "close" ? (
        <>
          <Line x1="6" y1="6" x2="18" y2="18" {...common} />
          <Line x1="18" y1="6" x2="6" y2="18" {...common} />
        </>
      ) : null}
      {props.name === "plus" ? (
        <>
          <Line x1="12" y1="5" x2="12" y2="19" {...common} />
          <Line x1="5" y1="12" x2="19" y2="12" {...common} />
        </>
      ) : null}
      {props.name === "arrowUp" ? (
        <>
          <Line x1="12" y1="19" x2="12" y2="5" {...common} />
          <Polyline points="5 12 12 5 19 12" {...common} />
        </>
      ) : null}
      {props.name === "comment" ? (
        <Path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5H7l-4 3v-5.2A8.5 8.5 0 1 1 20.5 11.5Z" {...common} />
      ) : null}
      {props.name === "edit" ? (
        <>
          <Path d="M12 20h8" {...common} />
          <Path d="M16.8 3.7a2.2 2.2 0 0 1 3.1 3.1L7.5 19.2 3 20l.8-4.5z" {...common} />
        </>
      ) : null}
      {props.name === "wrapText" ? (
        <>
          <Line x1="4" y1="6" x2="20" y2="6" {...common} />
          <Path d="M4 11h12a3 3 0 0 1 0 6H9" {...common} />
          <Polyline points="12 14 9 17 12 20" {...common} />
          <Line x1="4" y1="18" x2="6" y2="18" {...common} />
        </>
      ) : null}
      {props.name === "noWrapText" ? (
        <>
          <Line x1="4" y1="6" x2="20" y2="6" {...common} />
          <Line x1="4" y1="12" x2="20" y2="12" {...common} />
          <Line x1="4" y1="18" x2="12" y2="18" {...common} />
          <Polyline points="17 15 20 18 17 21" {...common} />
        </>
      ) : null}
      {props.name === "activity" ? (
        <Polyline points="3 12 7 12 9.5 5 13.5 19 16 12 21 12" {...common} />
      ) : null}
      {props.name === "bolt" ? (
        <Path d="M13.5 2.5 4.5 13.5h5l-1 8 9-11.5h-5l1-7.5z" {...common} />
      ) : null}
      {props.name === "copy" ? (
        <>
          <Rect x="9" y="9" width="11" height="11" rx="2" {...common} />
          <Path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" {...common} />
        </>
      ) : null}
      {props.name === "code" ? (
        <>
          <Polyline points="8 7 4 12 8 17" {...common} />
          <Polyline points="16 7 20 12 16 17" {...common} />
          <Line x1="13" y1="5" x2="11" y2="19" {...common} />
        </>
      ) : null}
      {props.name === "send" ? (
        <>
          <Path d="M5 12h13" {...common} />
          <Polyline points="12 5 19 12 12 19" {...common} />
        </>
      ) : null}
      {props.name === "mic" ? (
        <>
          <Rect x="9" y="3" width="6" height="11" rx="3" {...common} />
          <Path d="M5.5 11a6.5 6.5 0 0 0 13 0" {...common} />
          <Line x1="12" y1="17.5" x2="12" y2="21" {...common} />
          <Line x1="9" y1="21" x2="15" y2="21" {...common} />
        </>
      ) : null}
      {props.name === "stop" ? <Rect x="5" y="5" width="14" height="14" rx="3" fill={color} stroke="none" /> : null}
      {props.name === "search" ? (
        <>
          <Circle cx="11" cy="11" r="6.5" {...common} />
          <Line x1="16" y1="16" x2="20" y2="20" {...common} />
        </>
      ) : null}
      {props.name === "check" ? <Polyline points="5 12.5 10 17 19 7" {...common} /> : null}
      {props.name === "chevronDown" ? <Polyline points="6 9 12 15 18 9" {...common} /> : null}
      {props.name === "chevronRight" ? <Polyline points="9 6 15 12 9 18" {...common} /> : null}
      {props.name === "server" ? (
        <>
          <Rect x="4" y="4" width="16" height="7" rx="2" {...common} />
          <Rect x="4" y="13" width="16" height="7" rx="2" {...common} />
          <Circle cx="8" cy="7.5" r="1" fill={color} stroke="none" />
          <Circle cx="8" cy="16.5" r="1" fill={color} stroke="none" />
        </>
      ) : null}
      {props.name === "terminal" ? (
        <>
          <Rect x="3.5" y="4.5" width="17" height="15" rx="3" {...common} />
          <Polyline points="7 9 10 12 7 15" {...common} />
          <Line x1="12.5" y1="15" x2="17" y2="15" {...common} />
        </>
      ) : null}
      {props.name === "folder" ? (
        <Path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" {...common} />
      ) : null}
      {props.name === "message" ? (
        <Path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" {...common} />
      ) : null}
      {props.name === "diff" ? (
        <>
          <Path d="M7 4v16M4 7h6M4 17h6" {...common} />
          <Line x1="14" y1="7" x2="20" y2="7" {...common} />
          <Line x1="14" y1="17" x2="20" y2="17" {...common} />
          <Line x1="17" y1="4" x2="17" y2="10" {...common} />
        </>
      ) : null}
      {props.name === "eye" ? (
        <>
          <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" {...common} />
          <Circle cx="12" cy="12" r="3" {...common} />
        </>
      ) : null}
      {props.name === "bell" ? (
        <>
          <Path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z" {...common} />
          <Path d="M10 18a2 2 0 0 0 4 0" {...common} />
        </>
      ) : null}
      {props.name === "moon" ? <Path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" {...common} /> : null}
      {props.name === "sun" ? (
        <>
          <Circle cx="12" cy="12" r="4" {...common} />
          <Path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" {...common} />
        </>
      ) : null}
      {props.name === "trash" ? (
        <>
          <Path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" {...common} />
          <Line x1="10" y1="11" x2="10" y2="17" {...common} />
          <Line x1="14" y1="11" x2="14" y2="17" {...common} />
        </>
      ) : null}
      {props.name === "lock" ? (
        <>
          <Rect x="5" y="10" width="14" height="10" rx="2.5" {...common} />
          <Path d="M8 10V7a4 4 0 0 1 8 0v3" {...common} />
        </>
      ) : null}
      {props.name === "refresh" ? (
        <>
          <Path d="M20 11a8 8 0 1 0-2.4 6.3" {...common} />
          <Polyline points="20 5 20 11 14 11" {...common} />
        </>
      ) : null}
      {props.name === "globe" ? (
        <>
          <Circle cx="12" cy="12" r="8.5" {...common} />
          <Path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.1 3.8 8.5S14.5 18.2 12 20.5c-2.5-2.3-3.8-5.1-3.8-8.5S9.5 5.8 12 3.5z" {...common} />
        </>
      ) : null}
      {props.name === "wifi" ? (
        <>
          <Path d="M3.5 9a13 13 0 0 1 17 0" {...common} />
          <Path d="M6.5 12.5a8.5 8.5 0 0 1 11 0" {...common} />
          <Path d="M9.5 16a4 4 0 0 1 5 0" {...common} />
          <Circle cx="12" cy="19" r="1" fill={color} stroke="none" />
        </>
      ) : null}
      {props.name === "spark" ? (
        <Path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" {...common} />
      ) : null}
    </Svg>
  )
}
