// Household + membership domain logic (ahaqqu/RumaQ#331). Routes in
// apps/households.ts stay HTTP-shaped; every rule lives here so the
// ownership/last-owner/no-leak vocabulary has exactly one definition.
//
// Authorization model: roles are 'owner' | 'member' (CHECK constraint in
// 0001). Only owners invite and remove; members can leave; every household
// must retain >= 1 owner. Household existence is never leaked: a caller that
// is not a member gets the same 404 as a household that does not exist.
//
// Session continuity (review A2/A4): a user who loses a membership — by leave
// or by removal — is repointed at their next remaining household, or given a
// respawned baseline one when none remains, in the SAME atomic batch as the
// delete. Neither the departing user's session nor a crash mid-operation may
// ever strand a stale active pointer (the state the auth middleware's
// per-request re-check exists to contain).

import { encryptAiKey, decryptAiKey, sha256Hex } from './crypto.js'

export class HouseholdNotFoundError extends Error {
  constructor(message = 'Household not found') {
    super(message)
    this.name = 'HouseholdNotFoundError'
  }
}

export class HouseholdForbiddenError extends Error {
  constructor(message = 'Only household owners can do that') {
    super(message)
    this.name = 'HouseholdForbiddenError'
  }
}

export class LastOwnerError extends Error {
  constructor(message = 'A household must keep at least one owner') {
    super(message)
    this.name = 'LastOwnerError'
  }
}

export class InvalidInviteError extends Error {
  // One message for unknown / revoked / expired codes — the join endpoint
  // must not answer whether a code exists.
  constructor(message = 'Invalid or expired invite code') {
    super(message)
    this.name = 'InvalidInviteError'
  }
}

export type HouseholdRole = 'owner' | 'member'

export type HouseholdSummary = {
  id: string
  name: string
  role: HouseholdRole
  member_count: number
  is_active: boolean
  created_at: string
}

export type HouseholdMemberRow = {
  user_id: string
  role: HouseholdRole
  display_name: string | null
  birth_date: string | null
  joined_at: string
  name: string | null
  email: string | null
  picture: string | null
}

// The membership lookup every household route starts from: the household row
// plus the caller's role in one query. NULL answer covers both "no such
// household" and "not a member" — callers turn both into the same 404.
export async function getMembership(
  db: D1Database,
  householdId: string,
  userId: string
): Promise<{ id: string; name: string; role: HouseholdRole } | null> {
  return db
    .prepare(
      `SELECT h.id, h.name, m.role
         FROM households h
         JOIN household_members m ON m.household_id = h.id AND m.user_id = ?
        WHERE h.id = ?`
    )
    .bind(userId, householdId)
    .first<{ id: string; name: string; role: HouseholdRole }>()
}

export async function requireMembership(db: D1Database, householdId: string, userId: string) {
  const membership = await getMembership(db, householdId, userId)
  if (!membership) {
    throw new HouseholdNotFoundError()
  }
  return membership
}

// The owner gate for the invite/remove/rename surfaces. Throws the typed
// errors the app-level onError maps (403), so routes never re-derive roles.
export async function requireOwner(db: D1Database, householdId: string, userId: string) {
  const membership = await requireMembership(db, householdId, userId)
  if (membership.role !== 'owner') {
    throw new HouseholdForbiddenError()
  }
  return membership
}

// Households the user belongs to, with the caller's role, the household's
// size, and whether it is the user's active one (user_settings). Ordered by
// creation so the list is stable across calls.
export async function listHouseholds(db: D1Database, userId: string): Promise<HouseholdSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT h.id, h.name, h.created_at, m.role,
              (SELECT COUNT(*) FROM household_members cm WHERE cm.household_id = h.id)
                AS member_count,
              CASE WHEN s.active_household_id = h.id THEN 1 ELSE 0 END AS is_active
         FROM household_members m
         JOIN households h ON h.id = m.household_id
         LEFT JOIN user_settings s ON s.user_id = m.user_id
        WHERE m.user_id = ?
        ORDER BY h.created_at, h.id`
    )
    .bind(userId)
    .all<{
      id: string
      name: string
      created_at: string
      role: HouseholdRole
      member_count: number
      is_active: number
    }>()
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    member_count: row.member_count,
    is_active: row.is_active === 1,
    created_at: row.created_at,
  }))
}

// Default storage locations / stores seeded for a brand-new household — the
// same lists the login flows plant, extracted here so "create household" and
// the leave/remove baseline respawn plant the exact same baseline.
const LOCATION_SEEDS = [
  { label: 'Kulkas', sort_order: 1 },
  { label: 'Freezer', sort_order: 2 },
  { label: 'Lemari', sort_order: 3 },
  { label: 'Rak', sort_order: 4 },
]

const STORE_SEEDS = [{ label: 'Indomaret' }, { label: 'Alfamart' }, { label: 'Pasar' }]

const BASELINE_HOUSEHOLD_NAME = 'Rumahku'

// One batch: household row, owner membership, the seeds. The creator always
// lands as 'owner'; user_settings is NOT touched here — creating a household
// never silently switches the caller's active one (activation is explicit).
export async function createHousehold(
  db: D1Database,
  userId: string,
  name: string
): Promise<string> {
  const householdId = crypto.randomUUID()
  await db.batch([
    db
      .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
      .bind(householdId, name, userId),
    db
      .prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)')
      .bind(householdId, userId, 'owner'),
    ...LOCATION_SEEDS.map((loc) =>
      db
        .prepare('INSERT INTO locations (id, household_id, label, sort_order) VALUES (?, ?, ?, ?)')
        .bind(crypto.randomUUID(), householdId, loc.label, loc.sort_order)
    ),
    ...STORE_SEEDS.map((store) =>
      db
        .prepare('INSERT INTO stores (id, household_id, label) VALUES (?, ?, ?)')
        .bind(crypto.randomUUID(), householdId, store.label)
    ),
  ])
  return householdId
}

export async function renameHousehold(
  db: D1Database,
  householdId: string,
  userId: string,
  name: string
): Promise<void> {
  await requireOwner(db, householdId, userId)
  await db
    .prepare("UPDATE households SET name = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(name, householdId)
    .run()
}

export async function listMembers(
  db: D1Database,
  householdId: string
): Promise<HouseholdMemberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.user_id, m.role, m.display_name, m.birth_date, m.joined_at,
              u.name, u.email, u.picture
         FROM household_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.household_id = ?
        -- Owners head the list (the invite/remove affordances hang off that
        -- role); ties break deterministically on join time then id.
        ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.joined_at, m.user_id`
    )
    .bind(householdId)
    .all<HouseholdMemberRow>()
  return results
}

function readMemberRow(
  db: D1Database,
  householdId: string,
  targetUserId: string
): Promise<HouseholdMemberRow | null> {
  return db
    .prepare(
      `SELECT m.user_id, m.role, m.display_name, m.birth_date, m.joined_at,
              u.name, u.email, u.picture
         FROM household_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.user_id = ? AND m.household_id = ?`
    )
    .bind(targetUserId, householdId)
    .first<HouseholdMemberRow>()
}

// Owners edit any member's profile; a member edits their own. Role is never
// writable here (v1 keeps owner/member fixed at join; a future promotion flow
// owns the >= 1 owner invariant). An empty patch is a no-op read — the current
// row comes back, not the 404 that means "does not exist" (review A5).
export async function updateMemberProfile(
  db: D1Database,
  householdId: string,
  actorId: string,
  targetUserId: string,
  patch: { display_name?: string | null; birth_date?: string | null }
): Promise<HouseholdMemberRow | null> {
  const membership = await requireMembership(db, householdId, actorId)
  if (membership.role !== 'owner' && actorId !== targetUserId) {
    throw new HouseholdForbiddenError()
  }

  // The target must be a member of the same household — checked before any
  // write so an unknown user_id is a clean 404, not a no-op UPDATE.
  const target = await db
    .prepare('SELECT user_id FROM household_members WHERE household_id = ? AND user_id = ?')
    .bind(householdId, targetUserId)
    .first<{ user_id: string }>()
  if (!target) {
    return null
  }

  const updates: string[] = []
  const params: unknown[] = []
  if (patch.display_name !== undefined) {
    updates.push('display_name = ?')
    params.push(patch.display_name)
  }
  if (patch.birth_date !== undefined) {
    updates.push('birth_date = ?')
    params.push(patch.birth_date)
  }
  if (updates.length === 0) {
    return readMemberRow(db, householdId, targetUserId)
  }

  params.push(targetUserId, householdId)
  await db
    .prepare(
      `UPDATE household_members SET ${updates.join(', ')} WHERE user_id = ? AND household_id = ?`
    )
    .bind(...params)
    .run()

  return readMemberRow(db, householdId, targetUserId)
}

// Everything that must happen when `userId` loses membership in `householdId`
// (they were removed, or they left): the DELETE, the settings repoint to the
// oldest remaining membership — guarded so an already-switched pointer is
// never clobbered — and, when nothing remains, the baseline respawn. The
// caller commits the whole list in ONE db.batch, so the exact
// "membership gone but pointer stale" state a crash could otherwise produce
// is unrepresentable, and a membership-less session 401s nowhere (both login
// flows would also rebuild a baseline on the next sign-in; this makes the
// wait unnecessary — review A2/A4).
async function buildDepartureBatch(
  db: D1Database,
  householdId: string,
  userId: string
): Promise<D1PreparedStatement[]> {
  // Computed BEFORE the delete that rides the same batch — with the target
  // known, the repoint is a plain bound UPDATE instead of a subquery.
  const remaining = await db
    .prepare(
      `SELECT household_id FROM household_members
        WHERE user_id = ? AND household_id != ?
        ORDER BY joined_at, household_id LIMIT 1`
    )
    .bind(userId, householdId)
    .first<{ household_id: string }>()

  const statements: D1PreparedStatement[] = [
    db
      .prepare('DELETE FROM household_members WHERE household_id = ? AND user_id = ?')
      .bind(householdId, userId),
  ]

  if (remaining) {
    statements.push(
      db
        .prepare(
          "UPDATE user_settings SET active_household_id = ?, updated_at = datetime('now') WHERE user_id = ? AND active_household_id = ?"
        )
        .bind(remaining.household_id, userId, householdId)
    )
    return statements
  }

  const newId = crypto.randomUUID()
  statements.push(
    db
      .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
      .bind(newId, BASELINE_HOUSEHOLD_NAME, userId),
    db
      .prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)')
      .bind(newId, userId, 'owner'),
    ...LOCATION_SEEDS.map((loc) =>
      db
        .prepare('INSERT INTO locations (id, household_id, label, sort_order) VALUES (?, ?, ?, ?)')
        .bind(crypto.randomUUID(), newId, loc.label, loc.sort_order)
    ),
    ...STORE_SEEDS.map((store) =>
      db
        .prepare('INSERT INTO stores (id, household_id, label) VALUES (?, ?, ?)')
        .bind(crypto.randomUUID(), newId, store.label)
    ),
    db
      .prepare(
        "UPDATE user_settings SET active_household_id = ?, updated_at = datetime('now') WHERE user_id = ?"
      )
      .bind(newId, userId)
  )
  return statements
}

async function countOwners(db: D1Database, householdId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM household_members
        WHERE household_id = ? AND role = 'owner'`
    )
    .bind(householdId)
    .first<{ cnt: number }>()
  return row?.cnt ?? 0
}

// Removes a member (owner action). The >= 1 owner invariant is checked against
// the current row set, not the caller's claim, so removing the last owner 409s
// even if the data drifted. The removal and the removed member's session
// continuity commit in one atomic batch — symmetry with leaveHousehold, so an
// evicted member (like a leaver) is never locked out of join/create (A2/A4).
export async function removeMember(
  db: D1Database,
  householdId: string,
  actorId: string,
  targetUserId: string
): Promise<void> {
  await requireOwner(db, householdId, actorId)

  const target = await db
    .prepare('SELECT role FROM household_members WHERE household_id = ? AND user_id = ?')
    .bind(householdId, targetUserId)
    .first<{ role: HouseholdRole }>()
  if (!target) {
    throw new HouseholdNotFoundError()
  }
  if (target.role === 'owner' && (await countOwners(db, householdId)) <= 1) {
    throw new LastOwnerError()
  }

  await db.batch(await buildDepartureBatch(db, householdId, targetUserId))
}

// Self-service exit. Same last-owner rule: transfer ownership is a future
// flow — until it exists the last owner simply cannot leave.
export async function leaveHousehold(
  db: D1Database,
  householdId: string,
  userId: string
): Promise<void> {
  const membership = await requireMembership(db, householdId, userId)
  if (membership.role === 'owner' && (await countOwners(db, householdId)) <= 1) {
    throw new LastOwnerError()
  }

  await db.batch(await buildDepartureBatch(db, householdId, userId))
}

// Activation is membership-checked (switch only among your own households) —
// the value lands in user_settings.active_household_id, which the auth
// middleware resolves per request.
export async function setActiveHousehold(
  db: D1Database,
  userId: string,
  householdId: string
): Promise<void> {
  await requireMembership(db, householdId, userId)
  await db
    .prepare(
      "UPDATE user_settings SET active_household_id = ?, updated_at = datetime('now') WHERE user_id = ?"
    )
    .bind(householdId, userId)
    .run()
}

// ---------------------------------------------------------------------------
// Invite codes
// ---------------------------------------------------------------------------

// 10 chars from an alphabet without I/L/O/U/0/1 — unambiguous to read aloud
// or hand-copy, ~50 bits of entropy (far beyond brute force inside the
// rate-limited window).
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 10

export function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  let code = ''
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  }
  return code
}

// Users paste codes with stray spacing, lowercase, or copied from a link —
// normalize before hashing/lookup so a valid code never fails on presentation.
// This exact normalization is what the stored code_hash was computed over.
export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, '')
}

export type ActiveInvite = {
  id: string
  code: string
  created_at: string
  expires_at: string
}

// The current live invite for the invite screen. If none is active (never
// generated, rotated away, or expired) the owner generates one — GET never
// auto-creates so a read-only render cannot rotate codes as a side effect.
// The code is stored encrypted at rest (A8): only this owner-facing reveal
// decrypts; the join path matches on the deterministic hash instead, so a DB
// or backup leak yields neither usable codes nor lookup handles.
export async function getActiveInvite(
  db: D1Database,
  householdId: string,
  encryptionKey: string
): Promise<ActiveInvite | null> {
  const row = await db
    .prepare(
      `SELECT id, code_encrypted, created_at, expires_at
         FROM household_invites
        WHERE household_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`
    )
    .bind(householdId)
    .first<{ id: string; code_encrypted: string; created_at: string; expires_at: string }>()
  if (!row) {
    return null
  }
  return {
    id: row.id,
    code: await decryptAiKey(row.code_encrypted, encryptionKey),
    created_at: row.created_at,
    expires_at: row.expires_at,
  }
}

// (Re)issues the household's invite code. Rotating revokes every prior live
// code for the household in the same batch, so old links die the moment a new
// code exists. Expiry arithmetic stays in SQL (datetime('now', '+7 days')) so
// the stored format always matches the datetime('now') comparison in the
// validity checks — no JS/SQLite timestamp format drift. At rest the code
// exists only as a SHA-256 hash (the join lookup handle) plus its AES-GCM
// ciphertext under WORKER_ENCRYPTION_KEY (A8).
export async function createInvite(
  db: D1Database,
  householdId: string,
  userId: string,
  encryptionKey: string
): Promise<ActiveInvite> {
  const code = generateInviteCode()
  const codeHash = await sha256Hex(normalizeInviteCode(code))
  const codeEncrypted = await encryptAiKey(code, encryptionKey)
  await db.batch([
    db
      .prepare(
        "UPDATE household_invites SET revoked_at = datetime('now') WHERE household_id = ? AND revoked_at IS NULL"
      )
      .bind(householdId),
    db
      .prepare(
        "INSERT INTO household_invites (id, household_id, code_hash, code_encrypted, created_by, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+7 days'))"
      )
      .bind(crypto.randomUUID(), householdId, codeHash, codeEncrypted, userId),
  ])
  const invite = await getActiveInvite(db, householdId, encryptionKey)
  if (!invite) {
    throw new Error('Failed to create invite code')
  }
  return invite
}

export type JoinResult = {
  household: { id: string; name: string }
  already_member: boolean
}

// Redeems a code. Every failure mode (unknown, revoked, expired) throws the
// same InvalidInviteError so the answer never leaks whether a code exists;
// success is idempotent AT THE STORAGE LAYER (review A7): the membership
// insert is ON CONFLICT DO NOTHING, so a concurrent double-submit that races
// past any check still lands as one row and reports already_member instead of
// surfacing the PK violation as a 500.
export async function joinByCode(
  db: D1Database,
  userId: string,
  rawCode: string
): Promise<JoinResult> {
  const code = normalizeInviteCode(rawCode)
  if (code.length !== CODE_LENGTH) {
    throw new InvalidInviteError()
  }

  const codeHash = await sha256Hex(code)
  const invite = await db
    .prepare(
      `SELECT id, household_id FROM household_invites
        WHERE code_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')`
    )
    .bind(codeHash)
    .first<{ id: string; household_id: string }>()
  if (!invite) {
    throw new InvalidInviteError()
  }

  const household = await db
    .prepare('SELECT id, name FROM households WHERE id = ?')
    .bind(invite.household_id)
    .first<{ id: string; name: string }>()
  if (!household) {
    throw new InvalidInviteError()
  }

  const result = await db
    .prepare(
      `INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)
       ON CONFLICT (household_id, user_id) DO NOTHING`
    )
    .bind(invite.household_id, userId, 'member')
    .run()
  // meta.changes === 0 means the conflict path fired (already a member);
  // undefined (mocked D1 in unit tests) counts as inserted.
  const alreadyMember = (result as { meta?: { changes?: number } } | undefined)?.meta?.changes === 0

  return { household, already_member: alreadyMember }
}
