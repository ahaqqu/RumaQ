# Phase 08 — Frontend Modernization

**Status:** Mostly done (Tailwind v4 + Kumo, TanStack Router/Query, PWA shell, optimistic mutations, route-level pending/error components, legacy-CSS removal, offline fallback + SW runtime caching, and push/native decision docs are all in place; remaining work is route loader/Query-options alignment, PWA manifest categories/screenshots, offline/installability E2E, and cache-TTL validation)  
**Priority:** P1/P2  
**Source sections:** Section 2 of `docs/PROJECT_PLAN.md`  
**Estimated effort:** Medium-High (mostly finish-work now that the big migration is in place)

---

## Objective

Finish modernizing the frontend architecture for performance, maintainability, and offline-capable mobile use. The heavy lifting — Tailwind v4 + Kumo, TanStack Router, TanStack Query with IDB persistence, and a PWA shell — is already in place. This phase completes the migration: remove the remaining legacy CSS, add proper error boundaries and loading states, harden the offline experience, and document decisions on push notifications and native wrappers. The user impact is: _a fast, app-like experience that works even with a flaky connection_.

This phase remains intentionally after P0. It is a large refactor that should not block the MVP.

---

## Acceptance Criteria

1. Legacy CSS files (`frontend/src/styles/tokens.css`, `base.css`, `components.css`) are removed and all styling is expressed through Tailwind v4 + Kumo design tokens.
2. Kumo tokens are mapped to Tailwind theme extensions or CSS custom properties defined in `frontend/src/styles.css`, with no duplication.
3. Route-level `pendingComponent` and `errorComponent` are defined on all routes; a global error boundary protects the app root.
4. TanStack Query mutation hooks for locations and stores use optimistic updates, matching the `stock.js`/`plans.js` pattern.
5. The app has a real offline fallback page (`frontend/offline.html`) and the service worker is configured to serve it.
6. The service worker runtime-caches read API responses (`/api/stock`, `/api/plans`, `/api/purchases`) with a `NetworkFirst` strategy and a short TTL; write endpoints and AI endpoints are not cached.
7. The PWA manifest is enhanced with `scope`, `id`, a maskable icon, and recommended categories/screenshots.
8. Push notifications for expiry/run-out reminders are either implemented end-to-end or explicitly deferred with a documented decision.
9. A documented decision on mobile native wrappers (Capacitor vs. alternatives) is added to the project docs.
10. All existing tests pass and `./scripts/test.sh unit frontend` passes.
11. `./scripts/test.sh unit frontend` and `./scripts/test.sh automation-local frontend` pass (use `scripts/test.sh`; do not rely on `vp` aliases that may differ per environment).

---

## Dependencies

- Phases 01-05 for the backend endpoints the frontend consumes.
- Existing `frontend/src/styles.css`, `frontend/src/routeTree.gen.ts`, and `frontend/src/routes/`.
- Existing TanStack Query hooks in `frontend/src/lib/queries/`.
- Existing `vite-plugin-pwa` setup in `frontend/vite.config.js`.
- Existing Kumo design tokens and persona system.
- Existing `PersistQueryClientProvider` + IDB persister setup in `frontend/src/lib/queryClient.js`.

---

## Scope

### 1. Tailwind v4 + Kumo theme cleanup

- Keep `frontend/src/styles.css` using Tailwind v4 `@import "tailwindcss"` syntax. Do not regress to v3 or PostCSS-based configuration.
- Map Kumo tokens to Tailwind theme extensions via the `@theme` block (colors, spacing, typography, radii, shadows). Avoid duplicating the same values as standalone CSS custom properties in both `tokens.css` and `styles.css`.
- Migrate, then delete legacy files:
  - `frontend/src/styles/tokens.css`
  - `frontend/src/styles/base.css`
  - `frontend/src/styles/components.css`
- Replace custom component class names (e.g., `.btn`, `.card`, `.rail`, `.nav__item`) with Tailwind utilities incrementally. Pilot on the Settings page, then move page by page.
- Preserve motion preferences (`none`, `reduced`, `standard`) using Tailwind `motion-safe` and `prefers-reduced-motion`.
- Audit every inline `style={{ ... }}` block that references legacy CSS variables (e.g., `OfflineBanner`) and convert it to Tailwind utilities or Kumo theme tokens.

### 2. TanStack Router finish work

- File-based routing is already used in `frontend/src/routes/`. Keep the route tree for `/`, `/inventory`, `/plan`, `/history`, `/settings`, `/add`.
- Add `loader` functions to routes where data should be fetched before rendering (e.g., `/inventory`, `/plan`, `/history`).
- Add `pendingComponent` and `pendingMs`/`pendingMinMs` to each route so the UI shows skeletons instead of blank screens during loader delays.
- Add `errorComponent` to each route that surfaces a friendly fallback, a retry action, and persona-appropriate copy.
- Use `getRouteApi` to consume loader data inside components without circular imports.
- Pass `AbortSignal` to `fetch` in loaders so pending requests cancel on navigation.
- Use `staleTime`, `gcTime`, `preloadStaleTime`, and `staleReloadMode` to align route loader caching with TanStack Query cache behavior.

### 3. TanStack Query adoption finish work

- Query keys for each resource type already exist: `['settings']`, `['stock']`, `['plans']`, `['purchases']`, `['locations']`, `['stores']`, `['usage']`. Keep them.
- Server state is already wrapped in `useQuery` and `useMutation` hooks. The remaining work is to complete optimistic updates for:
  - `createLocation` / `deleteLocation` — update the `['locations']` cache immediately, roll back on error.
  - `createStore` / `deleteStore` — update the `['stores']` cache immediately, roll back on error.
- Keep `queryClient.invalidateQueries` for background refetch after mutations where optimistic updates are not enough.
- Add a global loading indicator driven by TanStack Query's `isFetching` if one is not already present.
- Keep the `PersistQueryClientProvider` + IDB persister configuration; it is the correct offline-read foundation.
- Ensure `queryClient.resumePausedMutations()` remains called on hydration so mutations persisted while offline can retry.

### 4. PWA manifest and service worker hardening

- Keep `vite-plugin-pwa` as the PWA engine. Do **not** add a standalone source `manifest.json`; let the plugin generate the manifest from `vite.config.js` so there is a single source of truth.
- Enhance the inline manifest in `frontend/vite.config.js`:
  - Add `id: '/'` for stable install behavior.
  - Add `scope: '/'`.
  - Add a maskable icon variant (e.g., `icon-maskable-512x512.png`).
  - Add `categories` and `screenshots` if assets are available.
  - Keep `display: 'standalone'`, `start_url: '/'`, theme color `#f4f8fb`, and background color `#f4f8fb`.
- Add `frontend/offline.html` as a real offline fallback page (not just `index.html`). The page should be a small, self-contained HTML file with the RumaQ brand, a concise offline message, and a button to retry once the network returns.
- Update the `VitePWA` `workbox` configuration:
  - Keep precaching for js/css/html/ico/png/svg/woff2.
  - Configure `navigateFallback` to `/offline.html` with a denylist that excludes `/offline.html` itself and all `/api/*` routes.
  - Add `runtimeCaching` for `/api/stock`, `/api/plans`, `/api/purchases` using `NetworkFirst` with a short TTL (e.g., 5 minutes) and a small cache limit. Exclude `/api/settings` and AI endpoints from runtime caching.
- Service worker registration is already handled by `PwaUpdatePrompt.jsx` using `virtual:pwa-register/react`. Keep that pattern and the update-prompt UX that asks the user before activating a new service worker.
- Document how a user can unregister the service worker if stale assets cause problems.

### 5. Offline / optimistic updates

- Keep the existing `useOnlineStatus` hook and `OfflineBanner` component. The hook correctly uses `useSyncExternalStore` to subscribe to `navigator.onLine` and `online`/`offline` events.
- Convert `OfflineBanner` styling from inline legacy-CSS-variable styles to Tailwind utilities so it survives legacy-CSS removal.
- Ensure cached reads work after a service-worker-controlled reload. Validate that TanStack Query's persisted cache and the service worker's runtime cache do not fight (align TTL/staleTime).
- For MVP, focus on read-only offline experience and optimistic UI for mutations when online. Advanced queued writes via Background Sync or an in-memory mutation queue are future work.
- Do not queue mutations when offline for MVP; instead, disable destructive actions or show a "will sync when online" indicator.

### 6. Push notifications

- This is P2 and may be deferred. If implemented end-to-end in this phase:
  - Implement Web Push in the service worker (`push` event handler, `notificationclick` handler, `pushsubscriptionchange` resubscription).
  - Backend: add `POST /api/push/subscribe` to store push subscriptions in D1 using the schema below.
  - Backend: add a scheduled Worker trigger (Cron Trigger) that checks for items expiring in 2 days or running out in 1 day and sends push notifications.
  - Ask user permission only after an explicit opt-in gesture (e.g., a toggle in Settings). Do not request permission on first app load.
  - Generate VAPID keys and store them as Worker secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`).
- If deferred, create a separate follow-up document that records:
  - The deferral decision.
  - iOS/Safari web-push limitations (Home Screen requirement, limited payload, permission UX differences).
  - The recommended VAPID/self-hosted approach versus OneSignal.
  - A rough implementation checklist for when the team picks it up.

### 7. Mobile native wrappers

- Evaluate Capacitor vs. Tauri vs. React Native vs. Cordova.
- Document the decision in `docs/MOBILE_WRAPPERS_DECISION.md` (or equivalent).
- Recommendation for this project:
  - **Capacitor** if a native store wrapper is ever needed, because it is the modern web-first wrapper with the strongest plugin ecosystem and the easiest path from a Vite/React PWA.
  - **Tauri** only if desktop + mobile + tiny binary/Rust native code is desired.
  - **React Native** only if a fully native UI is required and the team accepts a separate component model (often via Expo).
  - **Cordova** should be avoided for new work; it is largely superseded by Capacitor.
- For P2/MVP, keep focusing on the PWA install flow; native wrappers are future work.

### 8. Error boundaries and loading states

- Add a global error boundary around the app root. Use `react-error-boundary` or TanStack Router's default `ErrorComponent`, and provide different output in development (show stack) and production (friendly fallback).
- Add route-level `errorComponent` fallbacks using the existing persona copy for friendly messaging and a retry action.
- Add route-level `pendingComponent` skeletons using the existing `SkeletonRows` component.
- Migrate imperative `isLoading`/`isFetching` checks inside page components to declarative route-level boundaries where practical, but do not force a rewrite of every component if the current pattern is maintainable.
- Keep empty states and error states aligned with the Kumo persona system.

---

## Out of Scope

- Complete rewrite of the UI design (keep Kumo design).
- Server-side rendering (SSR) for Cloudflare Pages.
- React Native app.
- Real-time synchronization across devices (TanStack Query refetch is enough for MVP).
- Advanced background sync for mutations (basic offline read is enough for MVP).

---

## Database Changes

Add a table for push subscriptions if push notifications are implemented:

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
```

No other schema changes.

---

## Testing Strategy

### Unit tests

1. Update existing tests to work with route-level `pendingComponent`/`errorComponent` where added.
2. Add tests for the new optimistic update hooks (`locations`, `stores`) following the pattern in `frontend/src/lib/queries/stock.test.js`.
3. Add tests for the offline fallback page and service worker runtime caching if feasible.
4. Keep the existing `virtual:pwa-register/react` mock in `frontend/src/__mocks__/` so `PwaUpdatePrompt` tests do not regress.
5. Add tests for `OfflineBanner` after converting its styles to Tailwind utilities.

### E2E tests

1. Test PWA installability using Playwright or Lighthouse.
2. Test the offline fallback page by disabling network in Playwright.
3. Test optimistic updates feel instant and roll back correctly on forced failures.
4. Test push notification subscription flow only if implemented in this phase; otherwise skip and document the gap.

### Manual verification

1. Run the app and verify all pages load.
2. Verify the app is installable in Chrome/Edge DevTools.
3. Test offline mode by disconnecting network and reloading.
4. Verify optimistic updates feel instant.
5. Verify motion preferences still work after legacy CSS removal.
6. Verify the update prompt appears when a new service worker is waiting.

---

## Deployment & Secrets

- If push notifications are implemented, generate VAPID keys and store them as Worker secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`).
- The PWA manifest and service worker are built into static assets by `vite-plugin-pwa`; no backend changes are needed except for push subscriptions if implemented.
- No database migrations are required unless the push subscription table is added.

---

## Risks & Mitigations

| Risk                                                             | Impact | Mitigation                                                                      |
| ---------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| Legacy CSS removal breaks existing styling                       | High   | Migrate incrementally page by page; keep tests passing; compare screenshots.    |
| TanStack Query cache gets stale or inconsistent                  | Medium | Use proper query keys and invalidation; write tests for mutations.              |
| Service worker caches stale API responses                        | Medium | Use `NetworkFirst` + short TTL; keep AI endpoints and `/api/settings` uncached. |
| Route-level error boundaries hide useful debug info in dev       | Low    | Use different components for dev (show stack) and prod (friendly fallback).     |
| Push notifications require complex setup and may not work on iOS | Medium | Defer to P2; test on Android first; document iOS limitations.                   |
| Offline mutation queue is complex                                | Medium | For MVP, only cache reads; defer write queue to later.                          |

---

## Open Questions

1. **Should the offline fallback page be a separate HTML file or a route in the SPA?** Recommendation: separate `offline.html` so the service worker can serve it even before the SPA bundle is available.
2. **Should we cache `/api/settings` in the service worker?** Recommendation: no. Settings can change the app's behavior; always fetch fresh and rely on TanStack Query persistence for offline reads instead.
3. **Should we migrate all remaining custom classes at once or incrementally?** Recommendation: incrementally, one page per PR, to keep diffs reviewable.
4. **Should push notifications be implemented in this phase or deferred?** Recommendation: defer to a follow-up unless P2 scope is explicitly approved; the subscription backend can be built quickly, but scheduling, VAPID secrets, and iOS edge cases take time.
5. **Should native wrappers be Capacitor or something else?** Recommendation: Capacitor if needed, but PWA install is the priority for MVP.

---

## Alternatives Considered

- **Keep the existing hybrid CSS (Tailwind + custom components):** Rejected because two competing style systems increase maintenance cost and dilute the Kumo design language.
- **Keep the existing imperative loading states instead of route boundaries:** Rejected because route-level `pendingComponent`/`errorComponent` gives better UX and simpler page components.
- **Use Redux for state:** Rejected; TanStack Query handles server state and React Context handles client state, which is enough.
- **Build a native app first instead of PWA:** Rejected because PWA is faster to ship and covers most users.
- **Use Next.js or Remix instead of Vite + TanStack Router:** Rejected because the project is already on Vite and static Pages hosting is simpler.
- **Add a source `manifest.json` instead of letting `vite-plugin-pwa` generate it:** Rejected because the plugin already generates a correct manifest and a source file adds a second source of truth.

---

## Implementation Notes for a Future Session

1. Audit current component styles to identify all usages of legacy custom classes and CSS-variable inline styles.
2. Migrate the Settings page to pure Tailwind + Kumo first as the pilot.
3. Add `offline.html` and update `vite-plugin-pwa` Workbox config.
4. Add route-level `pendingComponent` and `errorComponent`.
5. Add optimistic updates to `frontend/src/lib/queries/locations.js` and `frontend/src/lib/queries/stores.js`.
6. Add runtime API caching to the service worker.
7. (Optional, deferred) Implement push notifications or create a separate design document.
8. (Optional, deferred) Document native wrapper decision.
9. Run the full test suite and open one or more PRs.

After this phase, the frontend is modern, fast, and feels like a native app with offline support.
