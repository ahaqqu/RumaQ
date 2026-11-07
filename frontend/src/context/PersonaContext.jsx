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

  useEffect(() => {
    if (initialPersona) {
      setPersonaState((prev) => ({ ...prev, ...initialPersona }))
    }
  }, [initialPersona])

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
