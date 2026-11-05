import { describe, it, expect } from 'vite-plus/test'
import {
  sniffDocumentMime,
  sanitizeFileName,
  sanitizeDocumentName,
  sanitizeDocumentLabel,
  contentDisposition,
} from '../lib/documents.js'
import {
  JPEG_BYTES,
  PNG_BYTES,
  PDF_BYTES,
  WEBP_BYTES,
  TEXT_BYTES,
} from './support/documents-harness.js'

// The upload sanitizers are pure lib units (ahaqqu/RumaQ#422) — split out of
// the route files (review B1 #422) so the route files stay at the HTTP seam
// and these contracts stay findable.
describe('upload sanitizers', () => {
  it('recognizes JPEG (FF D8 FF), PNG, WebP (RIFF/WEBP), and PDF (%PDF-)', () => {
    expect(sniffDocumentMime(JPEG_BYTES)).toBe('image/jpeg')
    expect(sniffDocumentMime(PNG_BYTES)).toBe('image/png')
    expect(sniffDocumentMime(WEBP_BYTES)).toBe('image/webp')
    expect(sniffDocumentMime(PDF_BYTES)).toBe('application/pdf')
  })

  it('rejects text bytes, truncated signatures, and empty payloads', () => {
    expect(sniffDocumentMime(TEXT_BYTES)).toBeNull()
    expect(sniffDocumentMime(new Uint8Array([0xff, 0xd8]))).toBeNull() // JPEG cut short
    expect(sniffDocumentMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00]))).toBeNull() // RIFF, not WEBP
    expect(sniffDocumentMime(new Uint8Array(0))).toBeNull()
  })

  it('pins the free-text name sanitizer: trim, control chars, 120-char cap (#422)', () => {
    expect(sanitizeDocumentName('  Kartu Keluarga  ')).toBe('Kartu Keluarga')
    expect(sanitizeDocumentName('KTP\u0000\u001f Bapak')).toBe('KTP Bapak')
    expect(sanitizeDocumentName('   ')).toBeNull()
    expect(sanitizeDocumentName('')).toBeNull()
    expect(sanitizeDocumentName('x'.repeat(200))).toBe('x'.repeat(120))
  })

  it('pins the optional label sanitizer: absent/empty → null, trim, 120-char cap', () => {
    expect(sanitizeDocumentLabel(undefined)).toBeNull()
    expect(sanitizeDocumentLabel('')).toBeNull()
    expect(sanitizeDocumentLabel('   ')).toBeNull()
    expect(sanitizeDocumentLabel(' Halaman 3 ')).toBe('Halaman 3')
    expect(sanitizeDocumentLabel('y'.repeat(150))).toBe('y'.repeat(120))
  })

  it('pins the file-name sanitize + header helpers: no paths, no control chars, RFC 5987 names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('C:\\Users\\akta.pdf')).toBe('akta.pdf')
    expect(sanitizeFileName('a\u0000b.pdf')).toBe('ab.pdf')
    expect(sanitizeFileName('   ')).toBeNull()
    expect(sanitizeFileName('')).toBeNull()
    expect(sanitizeFileName('.')).toBeNull()
    expect(contentDisposition('inline', 'akta lahir.pdf')).toBe(
      'inline; filename="akta lahir.pdf"; filename*=UTF-8\'\'akta%20lahir.pdf'
    )
    // The em-dash is not ASCII-representable: the quoted fallback underscores
    // it, while filename* carries the real name.
    expect(contentDisposition('attachment', 'kartu anak — bayi.pdf')).toBe(
      'attachment; filename="kartu anak _ bayi.pdf"; filename*=UTF-8\'\'kartu%20anak%20%E2%80%94%20bayi.pdf'
    )
  })
})
