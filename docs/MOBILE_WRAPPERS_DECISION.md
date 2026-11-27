# Mobile Native Wrappers — Decision Document

**Status:** Deferred (P2 / post-MVP)  
**Date:** 2026-08-02  
**Decision owner:** RumaQ maintainers

## Decision

RumaQ ships as a **Progressive Web App (PWA)**. No native mobile wrapper is implemented in the MVP.

If a native store wrapper is ever needed, the recommended choice is **Capacitor**.

## Evaluation

| Option           | Verdict                                 | Reasoning                                                                                                                                        |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Capacitor**    | **Recommended**                         | Modern web-first wrapper; strongest plugin ecosystem; easiest path from a Vite/React PWA; can reuse the existing web build with minimal changes. |
| **Tauri**        | Viable alternative                      | Best if desktop + mobile + tiny binary/Rust native code is desired. More complex for a team without Rust experience.                             |
| **React Native** | Use only if fully native UI is required | Requires a separate component model and often Expo. Highest rewrite cost; avoid unless native UX is a hard requirement.                          |
| **Cordova**      | Rejected                                | Legacy technology, largely superseded by Capacitor. Not recommended for new work.                                                                |

## Why PWA first

- **Fastest path to users:** No app store review, no separate build pipelines per platform.
- **Single codebase:** The existing Vite + React + TanStack architecture is reused unchanged.
- **Good enough for MVP:** Installability, offline reads, and optimistic updates cover the core mobile use case.
- **Can graduate to native later:** Capacitor can wrap the same web build when push notifications, native camera access, or store presence become requirements.

## When to reconsider

- Apple restricts PWA capabilities in a way that breaks core UX.
- We need deep native integrations (e.g., barcode scanning, background sync, native share sheet).
- App store presence becomes a marketing requirement.

## Migration path to Capacitor (future)

1. Add `@capacitor/core` and platform packages (`@capacitor/ios`, `@capacitor/android`).
2. Run `npx cap init` with the existing `frontend/dist` as the webDir.
3. Replace web-only APIs with Capacitor plugins where needed (camera, push, native storage).
4. Keep the web app as the primary build; native projects are thin wrappers.

## Risks

- iOS PWA limitations may push us toward a wrapper sooner than planned. Mitigation: monitor Safari/WebKit updates and user feedback.
- If we add Capacitor later, plugin choice and version alignment with Vite must be verified.
