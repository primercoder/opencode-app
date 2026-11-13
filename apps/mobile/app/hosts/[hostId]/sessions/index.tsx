import { Redirect, useLocalSearchParams } from "expo-router"

/**
 * The session list now lives in the workspace sidebar. Keep this route as a
 * redirect so old deep links still land in the single workspace.
 */
export default function SessionsRedirect() {
  const params = useLocalSearchParams<{ hostId: string; new?: string }>()
  return (
    <Redirect
      href={{
        pathname: "/hosts/[hostId]",
        params: {
          hostId: params.hostId,
          ...(params.new === "1" ? { new: "1" } : {}),
        },
      }}
    />
  )
}
