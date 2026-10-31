import { createContext, useContext, useState, useEffect } from 'react'

const AppContext = createContext(null)

const AI_KEY_STORAGE_KEY = 'rumaq_ai_key'

export function AppProvider({ children }) {
  const [aiKey, setAiKeyState] = useState(() => {
    try {
      return window.localStorage.getItem(AI_KEY_STORAGE_KEY) || null
    } catch {
      return null
    }
  })
  const [motion, setMotion] = useState('standard')
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantProposal, setAssistantProposal] = useState(null)
  // One-shot prompt seeded by a caller (e.g. the Home recipe card); the
  // assistant consumes it when it opens and clears it right after.
  const [assistantSeed, setAssistantSeed] = useState(null)

  const setAiKey = (value) => {
    const next = value || null
    setAiKeyState(next)
    try {
      if (next) {
        window.localStorage.setItem(AI_KEY_STORAGE_KEY, next)
      } else {
        window.localStorage.removeItem(AI_KEY_STORAGE_KEY)
      }
    } catch {
      // Storage may be disabled or full; in-memory state still works.
    }
  }

  useEffect(() => {
    document.documentElement.dataset.motion = motion
  }, [motion])

  return (
    <AppContext.Provider
      value={{
        aiKey,
        setAiKey,
        motion,
        setMotion,
        assistantOpen,
        setAssistantOpen,
        assistantProposal,
        setAssistantProposal,
        assistantSeed,
        setAssistantSeed,
      }}
    >
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
