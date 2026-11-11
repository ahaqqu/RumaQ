/**
 * Shared image fixtures for the automation suites.
 *
 * The receipts scan route byte-sniffs every upload (#606,
 * backend/src/lib/receipts.ts): a declared `image/jpeg` is only accepted when
 * the leading bytes carry the JPEG signature AND the file is at least 12 bytes
 * long. Keeping the fixture here — instead of inline in each step — makes that
 * floor impossible to miss: the old 6-byte `ff d8 ff e0 00 10` stub was
 * rejected 400 by the nightly suite (issue #653).
 *
 * These are the same leading bytes the backend suite pins in
 * backend/src/__tests__/receipts.test.ts: SOI + APP0, then the start of the
 * JFIF identifier. The AI provider test doubles treat the body as an opaque
 * blob, so no full image is required.
 */
export const JPEG_IMAGE_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
])
