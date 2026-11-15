import { createContext, useContext } from "react"

export type SelectionGuard = {
  onPressIn?: () => void
  onLongPress?: () => void
}

const SelectionGuardContext = createContext<SelectionGuard | null>(null)

export const SelectionGuardProvider = SelectionGuardContext.Provider

export function useSelectionGuard(): SelectionGuard | null {
  return useContext(SelectionGuardContext)
}
