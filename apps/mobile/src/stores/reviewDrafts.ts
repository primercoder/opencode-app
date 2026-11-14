import { create } from "zustand"
import type { ReviewComment } from "@/opencode/review"

export type StagedReview = {
  directory: string
  comments: ReviewComment[]
}

type ReviewDraftState = {
  bySession: Record<string, StagedReview | undefined>
  add: (sessionId: string, directory: string, comments: ReviewComment[]) => void
  remove: (sessionId: string, index: number) => void
  clear: (sessionId: string) => void
}

const EMPTY: ReviewComment[] = []

/**
 * Review comments stay on the phone until the user sends the next session
 * message. Nothing is written to the host when the review screen is closed.
 */
export const useReviewDrafts = create<ReviewDraftState>((set) => ({
  bySession: {},
  add: (sessionId, directory, comments) =>
    set((state) => {
      if (comments.length === 0) return state
      const current = state.bySession[sessionId]
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            directory: directory || current?.directory || "",
            comments: [...(current?.comments ?? []), ...comments],
          },
        },
      }
    }),
  remove: (sessionId, index) =>
    set((state) => {
      const current = state.bySession[sessionId]
      if (!current) return state
      const comments = current.comments.filter((_, position) => position !== index)
      if (comments.length === 0) {
        const next = { ...state.bySession }
        delete next[sessionId]
        return { bySession: next }
      }
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...current, comments },
        },
      }
    }),
  clear: (sessionId) =>
    set((state) => {
      if (!state.bySession[sessionId]) return state
      const next = { ...state.bySession }
      delete next[sessionId]
      return { bySession: next }
    }),
}))

export function selectStagedReview(sessionId: string | undefined): StagedReview | undefined {
  return sessionId ? useReviewDrafts.getState().bySession[sessionId] : undefined
}

export function useStagedReview(sessionId: string | undefined): StagedReview | undefined {
  return useReviewDrafts((state) => (sessionId ? state.bySession[sessionId] : undefined))
}

export function useStagedComments(sessionId: string | undefined): ReviewComment[] {
  return useReviewDrafts((state) => (sessionId ? state.bySession[sessionId]?.comments : undefined)) ?? EMPTY
}
