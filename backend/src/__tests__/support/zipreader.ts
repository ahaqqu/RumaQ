// The hand-written ZIP reader shared by the writer suite (zip.test.ts) and
// the export suite (plugin-export.test.ts) — T6-B1: one reader, two
// consumers, so a malformed writer fails identically in both. No third-party
// parser exists to lean on (the whole point of #440 is no new dependency),
// and the reader IS the validation: signatures, method 0, the UTF-8 flag,
// real sizes/CRC in local headers, and a central directory that lands
// exactly at the EOCD.

import { crc32 } from '../../lib/zip.js'

export type ParsedEntry = {
  name: string
  crc: number
  size: number
  bytes: Uint8Array<ArrayBuffer>
  /** The entry timestamp as written (local header, 2-second DOS fields). */
  dosTime: number
  dosDate: number
}

/**
 * Minimal ZIP reader: walks the central directory (the authoritative index)
 * and re-derives every entry's bytes from its LOCAL header position,
 * recomputing the CRC over what actually landed in the file. Throws on any
 * structural lie.
 */
export function parseZip(bytes: Uint8Array<ArrayBuffer>): Map<string, ParsedEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('no EOCD record found')
  const total = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  const entries = new Map<string, ParsedEntry>()
  let at = cdOffset
  for (let n = 0; n < total; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory signature')
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 20, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const localOffset = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen))
    if (method !== 0) throw new Error(`entry ${name}: not stored (method ${method})`)
    if ((flags & 0x0800) !== 0x0800) throw new Error(`entry ${name}: UTF-8 flag not set`)
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`entry ${name}: bad local header signature`)
    }
    const lfhNameLen = view.getUint16(localOffset + 26, true)
    const lfhExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen
    const data = bytes.subarray(dataStart, dataStart + size)
    if (crc32(data) !== crc) throw new Error(`entry ${name}: CRC mismatch over extracted bytes`)
    entries.set(name, {
      name,
      crc,
      size,
      bytes: data,
      dosTime: view.getUint16(localOffset + 10, true),
      dosDate: view.getUint16(localOffset + 12, true),
    })
    at += 46 + nameLen + extraLen + commentLen
  }
  if (at !== eocd) throw new Error('central directory does not end at the EOCD record')
  return entries
}

/**
 * Drain a ReadableStream of byte chunks into one buffer — how both suites
 * consume `zipStream` output (a route response's arrayBuffer() or a direct
 * reader loop) before `parseZip`.
 */
export async function collectStream(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}
