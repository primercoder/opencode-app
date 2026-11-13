import { Redirect, useLocalSearchParams } from "expo-router"

/**
 * Session switching happens inside the workspace; it must not add a page to
 * the navigation stack. Old session links redirect to the workspace.
 */
export default function SessionRedirect() {
  const params = useLocalSearchParams<{ hostId: string; sessionId: string }>()
  return (
    <Redirect
      href={{
        pathname: "/hosts/[hostId]",
        params: { hostId: params.hostId, session: params.sessionId },
      }}
    />
  )
}
