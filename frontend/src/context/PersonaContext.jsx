import { createContext, useContext, useEffect, useState } from 'react'
import { loadPersona, savePersona, deriveHue, applyTheme } from '../lib/persona.js'
import { useGeneratePersonaCopy } from '../lib/queries/ai-settings.js'

const PersonaContext = createContext(null)

export function PersonaProvider({ children, initialPersona }) {
  const [persona, setPersonaState] = useState(() => {
    const loaded = loadPersona()
    if (initialPersona) {
      return { ...loaded, ...initialPersona }
    }
    return loaded
  })

  // The server persona seed must win over localStorage exactly once per seed
  // VALUE: at boot (the mount initializer above already merges it) and when
  // the seed changes after mount — the login transition re-uses this provider
  // slot, so the initializer does not re-run there. `initialPersona` is
  // rebuilt inline by AuthGate on every render, so the sync compares the seed
  // field-wise instead of by object identity: the roles are free-form strings
  // (backend `optional(string())`, so `|` is legal input and a joined
  // signature could collide), and unrelated re-renders (focus refetches) must
  // not re-merge the seed over local persona edits, which the old
  // setState-in-effect did on every AuthGate render (#686).
  const [syncedSeed, setSyncedSeed] = useState(initialPersona)
  const seedChanged =
    initialPersona &&
    (!syncedSeed ||
      syncedSeed.userRole !== initialPersona.userRole ||
      syncedSeed.aiRole !== initialPersona.aiRole ||
      syncedSeed.enabled !== initialPersona.enabled)
  if (seedChanged) {
    setSyncedSeed(initialPersona)
    setPersonaState((prev) => ({ ...prev, ...initialPersona }))
  }

  const setPersona = (next) => {
    setPersonaState((prev) => {
      const updated = {
        ...prev,
        ...next,
        hue: deriveHue(next.userRole ?? prev.userRole, next.aiRole ?? prev.aiRole),
      }
      savePersona(updated)
      return updated
    })
  }

  // One server call behind the door (#523 P5): the browser sends the roles and
  // the built-in copy, the Worker owns the prompt, the provider and the key.
  // Rejects on failure so Settings can surface it; a 402 is the caller's
  // "no AI configured — keep the built-in copy" state, not an error here.
  const generateCopy = useGeneratePersonaCopy()
  const regenerateCopy = async (draftPersona = persona) => {
    const generated = await generateCopy.mutateAsync(draftPersona)
    if (generated) {
      setPersona({ generatedCopy: generated })
    }
    return generated
  }

  useEffect(() => {
    applyTheme(persona)
  }, [persona])

  return (
    <PersonaContext.Provider value={{ persona, setPersona, regenerateCopy }}>
      {children}
    </PersonaContext.Provider>
  )
}

export function usePersona() {
  const ctx = useContext(PersonaContext)
  if (!ctx) throw new Error('usePersona must be used inside PersonaProvider')
  return ctx
}
