import { useEffect } from "react"
import { AppState } from "react-native"

/** Calls back when the app returns to the foreground. */
export function useForeground(callback: () => void): void {
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") callback()
    })
    return () => subscription.remove()
  }, [callback])
}
