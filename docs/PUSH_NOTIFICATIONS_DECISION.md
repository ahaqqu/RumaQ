# Push Notifications — Deferral Decision

**Status:** Deferred (P2 / post-MVP)  
**Date:** 2026-08-02  
**Decision owner:** RumaQ maintainers

## Decision

Push notifications for expiry/run-out reminders are **not implemented**. They remain a P2 feature to be picked up after MVP.

## Why deferred

- **MVP priority:** The core offline-capable PWA and optimistic UI are P1; push is a trust/convenience amplifier, not a blocker.
- **Implementation surface:** End-to-end push requires:
  - VAPID key generation and Worker secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`).
  - Backend subscription endpoint (`POST /api/push/subscribe`) and D1 table.
  - Scheduled Worker Cron Trigger to evaluate expiring/running-out items.
  - Service worker `push`, `notificationclick`, and `pushsubscriptionchange` handlers.
  - Opt-in UX in Settings and browser permission handling.
- **iOS/Safari limitations:**
  - Web Push on iOS is only available for apps added to the Home Screen.
  - Payload size is limited (~4 KB) and notification UX differs from Android.
  - Permission timing and persistence differ across Safari versions.
- **Risk/reward:** Push notifications are valuable but the setup is complex and platform-specific; deferring keeps MVP scope tight.

## Recommended approach when picked up

1. **Self-hosted VAPID** (preferred):
   - Generate keys via `npx web-push generate-vapid-keys`.
   - Store `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` as Worker secrets.
   - Keep full control over payloads and subscription data.
2. **OneSignal or similar** (alternative):
   - Faster to ship cross-platform but introduces a third-party dependency and may require its own SDK.
   - Consider only if time-to-market beats self-hosting control.

## Implementation checklist

- [ ] Add `push_subscriptions` D1 table for subscriptions.
- [ ] Add `POST /api/push/subscribe` to store subscriptions keyed by user.
- [ ] Add `DELETE /api/push/subscribe` for unsubscribe/invalid subscriptions.
- [ ] Implement service worker handlers:
  - `push` event to show notification.
  - `notificationclick` to open the app to the relevant item.
  - `pushsubscriptionchange` to resubscribe and update the backend.
- [ ] Add Settings toggle that asks permission only after explicit opt-in.
- [ ] Add Cron Trigger that runs daily and sends notifications for:
  - Items expiring in ≤ 2 days.
  - Items estimated to run out in ≤ 1 day.
- [ ] Add unit tests for subscription mutation and service worker handlers.
- [ ] Test on Android Chrome first, then document iOS Home Screen limitations.

## Open questions

- Should the Cron Trigger run per user or per household?
- Should notifications batch multiple reminders into a single summary notification?
- What is the fallback if a subscription expires or the user denies permission?
