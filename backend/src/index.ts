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
