export type AuthProps = {
  userId: string
  householdId: string
}

export type RateLimitConfig = {
  windowMs: number
  maxRequests: number
}

export type Env = {
  Bindings: {
    DB: D1Database
    RECEIPTS: R2Bucket
    GOOGLE_CLIENT_ID: string
    GOOGLE_CLIENT_SECRET: string
    WORKER_JWT_SECRET: string
    WORKER_ENCRYPTION_KEY: string
    HAQITA_INGEST_SECRET?: string
    PAGES_ORIGIN?: string
    EMAIL_AUTH_ENABLED: string
    ASSETS: Fetcher
    TEST_MODE?: string
    RUN_SECRETS_CHECK?: string
    RATE_LIMIT_WINDOW_MS?: string
    RATE_LIMIT_MAX_REQUESTS?: string
    props?: AuthProps
  }
  Variables: {
    userId: string
    householdId: string
  }
}
