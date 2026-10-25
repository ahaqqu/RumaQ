import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { BrandMark } from '../components/icons.jsx'
import { login, emailLogin } from '../lib/api'
import { useEmailAuthStatus } from '../lib/queries'
import { Button } from '../components/Button.jsx'

export function Login() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // Null until the status is known so the card renders complete in one paint;
  // inserting the email form after mount would re-center the card and cause
  // a layout shift. The persisted query cache resolves it without network on
  // repeat visits; only true cold loads wait on the fetch.
  const { data } = useEmailAuthStatus()
  const emailAuth = data?.enabled ?? null
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleEmailLogin = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await emailLogin(email, password)
      queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate({ to: '/' })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (emailAuth === null) {
    return <div className="min-h-dvh grid place-items-center p-6 bg-surface" aria-busy="true" />
  }

  return (
    <div className="min-h-dvh grid place-items-center p-6 bg-surface">
      <div className="flex flex-col items-center gap-4 max-w-[320px] w-full text-center px-6 py-10 bg-surface-raised border border-border rounded-xl shadow-md">
        <BrandMark size={48} />
        <h1 className="text-2xl font-bold tracking-tight">RumaQ</h1>
        <p className="text-md text-text-muted leading-snug">
          {t('login.desc', 'Household shopping & inventory assistant')}
        </p>

        <Button block className="mt-2" onClick={login}>
          {t('login.signIn', 'Sign in with Google')}
        </Button>

        {emailAuth && (
          <>
            <div className="flex items-center gap-3 w-full text-text-muted text-sm">
              <hr className="flex-1" />
              <span>{t('login.or', 'or')}</span>
              <hr className="flex-1" />
            </div>

            <form className="flex flex-col gap-2 w-full text-left" onSubmit={handleEmailLogin}>
              <label className="text-sm font-medium text-text-muted" htmlFor="email">
                {t('login.email', 'Email')}
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="bg-surface"
              />

              <label className="text-sm font-medium text-text-muted" htmlFor="password">
                {t('login.password', 'Password')}
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="bg-surface"
              />

              {error && <p className="text-danger text-sm text-center">{error}</p>}

              <Button block type="submit" disabled={loading} className="mt-1">
                {loading
                  ? t('login.signingIn', 'Signing in…')
                  : t('login.signInEmail', 'Sign in with email')}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
