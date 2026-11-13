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
    /**
     * Receipt image bytes (grocery receipts) — the same PRIVATE bucket as
     * DOCUMENTS, objects under the receipts/<household_id>/<yyyy>/<mm>/ key
     * prefix (lib/receipts.ts buildKey). Since #503 no route touches this
     * binding directly: lib/receipts.ts receiptsStorage() is the one place
     * that reads it (building the StorageAdapter for the purchase routes, the
     * vault-registry pattern), so the #442 adapter swap covers receipts too —
     * a binding + adapter change, no route edits.
     */
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
    /**
     * DokumenQ file-service base URL (ahaqqu/RumaQ#442 Mode A cutover) — a
     * plain, public hostname, not a secret. Declared in
     * backend/cloudflare.config.ts as a text binding. Part of the storage
     * cutover pair: set together with DOKUMENQ_APP_SECRET the storage port
     * (ports/storage/select.ts) swaps to the DokumenQ adapter; leave both
     * unset to keep R2.
     */
    DOKUMENQ_BASE_URL?: string
    /**
     * DokumenQ app secret (bearer for /v1/authorize + the documents CRUD,
     * DokumenQ API.md §1.1) — issued once by the DokumenQ admin registration
     * for the RumaQ app. Set OUT-OF-BAND on the api Worker only
     * (`cf workers secrets update`), like HAQITA_INGEST_SECRET: never
     * declared in cloudflare.config.ts, so an ordinary deploy preserves it,
     * and branch/preview Workers run without it and keep the R2 adapter.
     * Never enters the repo.
     */
    DOKUMENQ_APP_SECRET?: string
    /**
     * Review script token (ahaqqu/RumaQ#656) — bearer for the two scripted
     * review surfaces: GET /api/admin/review/queue-report (read-only
     * aggregates) and POST /api/admin/review/evaluate (assist-mode verdict
     * fill acting as the deployment's admin user). Set OUT-OF-BAND on the api
     * Worker only (`cf workers secrets update`), like HAQITA_INGEST_SECRET:
     * never declared in cloudflare.config.ts, never enters the repo. A script
     * exports it locally as RUMAQ_REVIEW_TOKEN; the two names are different
     * on purpose — the Worker secret and the caller's env are not the same
     * trust domain.
     */
    REVIEW_SCRIPT_TOKEN?: string
    /** Rotation successor accepted alongside the primary during a secret
     *  rotation window (same rule as HAQITA_INGEST_SECRET_NEXT). */
    REVIEW_SCRIPT_TOKEN_NEXT?: string
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
