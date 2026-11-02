// Household + membership domain logic (ahaqqu/RumaQ#331). Routes in
// apps/households.ts stay HTTP-shaped; every rule lives here so the
// ownership/last-owner/no-leak vocabulary has exactly one definition.
//
// Authorization model: roles are 'owner' | 'member' (CHECK constraint in
// 0001). Only owners invite and remove; members can leave; every household
// must retain >= 1 owner. Household existence is never leaked: a caller that
// is not a member gets the same 404 as a household that does not exist.

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

async function requireMembership(db: D1Database, householdId: string, userId: string) {
  const membership = await getMembership(db, householdId, userId)
  if (!membership) {
    throw new HouseholdNotFoundError()
  }
  return membership
}

async function requireOwner(db: D1Database, householdId: string, userId: string) {
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
// "left my last household" respawn the exact same baseline.
const LOCATION_SEEDS = [
  { label: 'Kulkas', sort_order: 1 },
  { label: 'Freezer', sort_order: 2 },
  { label: 'Lemari', sort_order: 3 },
  { label: 'Rak', sort_order: 4 },
]

const STORE_SEEDS = [{ label: 'Indomaret' }, { label: 'Alfamart' }, { label: 'Pasar' }]

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

// Owners edit any member's profile; a member edits their own. Role is never
// writable here (v1 keeps owner/member fixed at join; a future promotion flow
// owns the >= 1 owner invariant).
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
    return null
  }

  params.push(targetUserId, householdId)
  await db
    .prepare(
      `UPDATE household_members SET ${updates.join(', ')} WHERE user_id = ? AND household_id = ?`
    )
    .bind(...params)
    .run()

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

// A user leaving or being removed must not strand their session on a household
// they no longer belong to: repoint user_settings at their next membership
// (oldest first), or NULL it — the auth middleware then resolves their new
// baseline, and the login flow rebuilds a household if they have none left.
async function repointActiveHousehold(db: D1Database, userId: string, leftHouseholdId: string) {
  await db
    .prepare(
      `UPDATE user_settings
          SET active_household_id = (
                SELECT household_id FROM household_members
                 WHERE user_id = ? AND household_id != ?
                 ORDER BY joined_at, household_id LIMIT 1
              ),
              updated_at = datetime('now')
        WHERE user_id = ? AND active_household_id = ?`
    )
    .bind(userId, leftHouseholdId, userId, leftHouseholdId)
    .run()
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
// even if the data drifted.
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

  await db
    .prepare('DELETE FROM household_members WHERE household_id = ? AND user_id = ?')
    .bind(householdId, targetUserId)
    .run()
  await repointActiveHousehold(db, targetUserId, householdId)
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

  await db
    .prepare('DELETE FROM household_members WHERE household_id = ? AND user_id = ?')
    .bind(householdId, userId)
    .run()
  await repointActiveHousehold(db, userId, householdId)

  // Leaving the last household must not brick the session: the login flow
  // would rebuild one on the next sign-in, but every household-scoped route
  // 401s until then. Respawn the baseline household immediately.
  const remaining = await db
    .prepare(
      'SELECT household_id FROM household_members WHERE user_id = ? ORDER BY joined_at, household_id LIMIT 1'
    )
    .bind(userId)
    .first<{ household_id: string }>()
  if (!remaining) {
    const newId = await createHousehold(db, userId, 'Rumahku')
    await db
      .prepare(
        "UPDATE user_settings SET active_household_id = ?, updated_at = datetime('now') WHERE user_id = ?"
      )
      .bind(newId, userId)
      .run()
  }
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
// normalize before lookup so a valid code never fails on presentation.
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
export async function getActiveInvite(
  db: D1Database,
  householdId: string
): Promise<ActiveInvite | null> {
  return db
    .prepare(
      `SELECT id, code, created_at, expires_at
         FROM household_invites
        WHERE household_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`
    )
    .bind(householdId)
    .first<ActiveInvite>()
}

// (Re)issues the household's invite code. Rotating revokes every prior live
// code for the household in the same batch, so old links die the moment a new
// code exists. Expiry arithmetic stays in SQL (datetime('now', '+7 days')) so
// the stored format always matches the datetime('now') comparison in the
// validity checks — no JS/SQLite timestamp format drift.
export async function createInvite(
  db: D1Database,
  householdId: string,
  userId: string
): Promise<ActiveInvite> {
  const code = generateInviteCode()
  await db.batch([
    db
      .prepare(
        "UPDATE household_invites SET revoked_at = datetime('now') WHERE household_id = ? AND revoked_at IS NULL"
      )
      .bind(householdId),
    db
      .prepare(
        "INSERT INTO household_invites (id, household_id, code, created_by, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+7 days'))"
      )
      .bind(crypto.randomUUID(), householdId, code, userId),
  ])
  const invite = await getActiveInvite(db, householdId)
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
// success is idempotent — an existing member rejoining gets their household
// back with already_member=true (and no duplicate membership row).
export async function joinByCode(
  db: D1Database,
  userId: string,
  rawCode: string
): Promise<JoinResult> {
  const code = normalizeInviteCode(rawCode)
  if (code.length !== CODE_LENGTH) {
    throw new InvalidInviteError()
  }

  const invite = await db
    .prepare(
      `SELECT id, household_id FROM household_invites
        WHERE code = ? AND revoked_at IS NULL AND expires_at > datetime('now')`
    )
    .bind(code)
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

  const existing = await db
    .prepare('SELECT 1 AS one FROM household_members WHERE household_id = ? AND user_id = ?')
    .bind(invite.household_id, userId)
    .first<{ one: number }>()
  if (existing) {
    return { household, already_member: true }
  }

  await db
    .prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)')
    .bind(invite.household_id, userId, 'member')
    .run()

  return { household, already_member: false }
}
