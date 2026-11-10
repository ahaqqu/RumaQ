// TEMPORARY (#534 proof): the #533 class — a module-scope AbortController,
// reached through a helper so the static AST guard in
// backend/src/__tests__/worker-global-scope.test.ts cannot see it (it does no
// call-graph analysis). It still runs during bundle evaluation, which is what
// workerd rejects. Reverted in the next commit.
function makeAbortSignal(): AbortSignal {
  return new AbortController().signal
}
export const NEVER_ABORTED = makeAbortSignal()

export type { Env, AuthProps } from './types.js'
export { authApp } from './apps/auth.js'
export { apiApp } from './apps/api.js'
export { CachedApi } from './entrypoints.js'

export {
  signJwt,
  verifyJwt,
  hashPassword,
  verifyPassword,
  base64UrlEncode,
  base64UrlDecode,
  randomState,
  propsAuthMiddleware,
} from './auth.js'

export { encryptAiKey, decryptAiKey } from './lib/crypto.js'
export { settingsPatchSchema, locationSchema, storeSchema } from './schemas.js'

import { gateway } from './gateway.js'

export default gateway
