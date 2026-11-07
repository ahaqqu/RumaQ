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
    /** Brochure images (issue #293) — private, served only via the Worker proxy. */
    BROCHURES: R2Bucket
    /**
     * Document vault bytes (issue #388) — the same PRIVATE bucket as
     * RECEIPTS, bound under its own name so the vault's StorageAdapter wiring
     * never touches the receipts code path (and vice versa). Objects live
     * under the documents/<household_id>/<document_id> key prefix
     * (plugins/documents/keys.ts); swapping to the #391 file service later is
     * a config + adapter change, no route edits.
     */
    DOCUMENTS: R2Bucket
    GOOGLE_CLIENT_ID: string
    GOOGLE_CLIENT_SECRET: string
    WORKER_JWT_SECRET: string
    WORKER_ENCRYPTION_KEY: string
    HAQITA_INGEST_SECRET?: string
    /** Rotation successor accepted alongside the primary during a secret
     *  rotation window (ahaqqu/RumaQ#376). Nothing promotes it automatically:
     *  the deploy writes neither secret (ahaqqu/RumaQ#456), so the operator
     *  writes it as HAQITA_INGEST_SECRET and deletes this one. */
    HAQITA_INGEST_SECRET_NEXT?: string
    PAGES_ORIGIN?: string
    EMAIL_AUTH_ENABLED: string
    ASSETS: Fetcher
    TEST_MODE?: string
    RUN_SECRETS_CHECK?: string
    RATE_LIMIT_WINDOW_MS?: string
    RATE_LIMIT_MAX_REQUESTS?: string
    /** Login limiter override for the local/e2e harness (ahaqqu/RumaQ#499).
     *  Unset (production) keeps the 10 attempts / 60 s defaults in
     *  lib/rate-limit.ts; invalid values fall back to those defaults. */
    LOGIN_RATE_MAX?: string
    LOGIN_RATE_WINDOW_SEC?: string
    // The retired shared AI key (RUMAQ_SERVER_AI_{PROVIDER,KEY,MODEL}) is
    // deliberately NOT declared any more: D8 removed the server fallback in
    // #523 P1, and an env var no code reads must not look like configuration.
    props?: AuthProps
  }
  Variables: {
    userId: string
    householdId: string
  }
}
