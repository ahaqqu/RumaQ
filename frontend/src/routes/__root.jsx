import { Outlet, createRootRoute } from '@tanstack/react-router'
import React, { Suspense } from 'react'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { PersonaProvider } from '../context/PersonaContext.jsx'
import { AppProvider } from '../context/AppContext.jsx'
import { AppShell } from '../components/AppShell.jsx'
import { Login } from '../pages/Login.jsx'
import { PwaUpdatePrompt } from '../components/PwaUpdatePrompt.jsx'
import { RouteError } from '../components/RouteError.jsx'
import { queryClient, persistOptions } from '../lib/queryClient.js'
import { useMe } from '../lib/queries/me.js'
import { useSettings } from '../lib/queries/settings.js'

function AuthGate() {
  const { data: me, isLoading } = useMe()
  const { data: settings } = useSettings()

  if (isLoading) return null

  if (!me?.user) {
    return (
      <PersonaProvider>
        <Login />
      </PersonaProvider>
    )
  }

  const initialPersona = settings
    ? {
        userRole: settings.persona_user_role || '',
        aiRole: settings.persona_ai_role || '',
        enabled: settings.persona_enabled,
      }
    : undefined

  return (
    <PersonaProvider initialPersona={initialPersona}>
      <AppShell>
        <Outlet />
      </AppShell>
    </PersonaProvider>
  )
}

const ReactQueryDevtools = import.meta.env.DEV
  ? React.lazy(() =>
      import('@tanstack/react-query-devtools').then((m) => ({
        default: m.ReactQueryDevtools,
      }))
    )
  : () => null

function RootComponent() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
      onSuccess={() => queryClient.resumePausedMutations()}
    >
      <AppProvider>
        <AuthGate />
      </AppProvider>
      <Suspense fallback={null}>
        <ReactQueryDevtools initialIsOpen={false} />
      </Suspense>
      <PwaUpdatePrompt />
    </PersistQueryClientProvider>
  )
}

export const Route = createRootRoute({
  component: RootComponent,
  errorComponent: RouteError,
})
