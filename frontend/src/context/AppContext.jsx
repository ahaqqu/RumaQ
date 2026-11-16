import { createContext, useContext, useState, useEffect } from 'react'

const AppContext = createContext(null)

// L7 (audit 2026-11-16): the plaintext browser AI key is retired — nothing
// reads or writes it anymore (the assistant derives "connected" from the
// household's capability status alone, api.ts never carries key material),
// so older builds' leftover secret is purged from JS-readable storage on
// boot and must never be written again.
const RETIRED_AI_KEY_STORAGE_KEY = 'rumaq_ai_key'

export function AppProvider({ children }) {
  const [motion, setMotion] = useState('standard')
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantProposal, setAssistantProposal] = useState(null)
  // One-shot prompt seeded by a caller (e.g. the Home recipe card); the
  // assistant consumes it when it opens and clears it right after.
  const [assistantSeed, setAssistantSeed] = useState(null)

  useEffect(() => {
    document.documentElement.dataset.motion = motion
  }, [motion])

  // C5 rides L7 (audit): the pre-split browser key path is removed now, not
  // "until P5 removes that path" — the dot must claim connectivity only when
  // the household's ai_status actually backs it.
  useEffect(() => {
    try {
      window.localStorage.removeItem(RETIRED_AI_KEY_STORAGE_KEY)
    } catch {
      // Storage may be disabled; there is nothing to purge then.
    }
  }, [])

  return (
    <AppContext.Provider
      value={{
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
