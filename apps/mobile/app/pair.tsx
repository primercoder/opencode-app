import { View } from "react-native"

/**
 * The root layout intercepts `ocremote://pair#...` links and opens the add-host
 * screen. This route exists so Expo Router does not show a not-found screen
 * while that navigation happens.
 */
export default function PairLinkRoute() {
  return <View />
}
