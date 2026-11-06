// Document-vault KEY POLICY (ahaqqu/RumaQ#388 MVP), owned by the documents
// plugin (re-homed from lib/storage.ts by ticket 4, plugin architecture
// §4.2: key-building helpers are vault policy, not port policy — they move
// WITH the plugin, while the StorageAdapter port itself lives in
// backend/src/ports/storage/). Receipts keep their own keys under lib/.

// One private bucket, two key namespaces (the issue's "bucket or hard-prefix"
// answer is hard-prefix): receipts/ (purchases) and documents/ (the vault).
// The DOCUMENTS binding points at the same private bucket as RECEIPTS — no
// new infrastructure, no shared code path.
export const DOCUMENTS_KEY_PREFIX = 'documents'

/**
 * The only key shape the vault writes or reads — no traversal, no escapes.
 * Since #422 a document groups N files and every file is its own object:
 * documents/<household>/<document>/<file>. The pre-#422 shape
 * documents/<household>/<document> lives on as the migrated first file of
 * every existing document (0025 reuses the key — no byte movement).
 */
export function buildDocumentFileKey(
  householdId: string,
  documentId: string,
  fileId: string
): string {
  return `${DOCUMENTS_KEY_PREFIX}/${householdId}/${documentId}/${fileId}`
}

/** Is this key one of ours, legacy or current? (Receipts are never touched.) */
export function isDocumentKey(key: string): boolean {
  const parts = key.split('/')
  return (parts.length === 3 || parts.length === 4) && parts[0] === DOCUMENTS_KEY_PREFIX
}
