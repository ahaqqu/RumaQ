// Dependency-free stored (uncompressed) ZIP writer (ahaqqu/RumaQ#440 —
// plugin architecture ticket 6, plan §3.4: "per-plugin archive export
// (zip/CSV)"). The NO-DEPENDENCY decision is the ticket's acceptance
// criterion: fflate exists only as @vitest/ui's transitive devDependency —
// importing it would ADD a third-party dependency to the Worker bundle, so
// the honest option is a minimal writer over the ZIP appnote format. Stored
// entries (method 0) need no compression code: ~100 lines for CRC-32, local
// headers, central directory and EOCD. Compression was never the point of
// an export (document scans are already-compressed JPEG/PDF bytes — stored
// entries cost near-zero overhead on them and keep the writer trivial).
//
// Design notes:
// - STREAMING, but per-entry buffered: each entry's bytes are resolved
//   fully before its local header is emitted, so the header carries the
//   REAL sizes and CRC — no data descriptors (general-purpose bit 3), which
//   are the streaming-zip compatibility trap (some unzippers mishandle
//   them). Memory cost = the largest single entry (the vault's per-file cap
//   is 10 MB, lib/plugins/documents: DOCUMENT_MAX_BYTES), never the whole
//   archive — well under the Workers 128 MB isolate limit even for a
//   multi-hundred-MB vault, because entries stream through one at a time.
// - Names are UTF-8 (general-purpose bit 11 set) — Indonesian file names
//   survive every modern unzipper.
// - No zip64: entries and the archive both stay far below 4 GB (per-archive
//   ceilings are set by the export job's file budget, not by this writer).

export type ZipEntry = {
  /** Archive path. `/` separators create folders; callers keep them flat. */
  name: string
  /** The bytes, or a loader resolved lazily as the stream pulls this entry. */
  data: Uint8Array | (() => Uint8Array | Promise<Uint8Array>)
  /** Entry timestamp (local header + central directory). Default: now. */
  modified?: Date
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, reflected poly 0xEDB88320) — the table builds once per
// isolate on first use; ~8 MB/s×10 MB files make the per-export cost trivial
// against the storage reads that dominate.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// DOS date/time (2-second resolution, 1980 epoch) — the only timestamp form
// a ZIP carries.
// ---------------------------------------------------------------------------

function dosDateTime(at: Date): { time: number; date: number } {
  const year = at.getUTCFullYear()
  // Out-of-range years clamp into the representable window rather than
  // corrupting the field: 1980 is the DOS epoch floor, 2107 the ceiling.
  const dosYear = Math.min(Math.max(year, 1980), 2107) - 1980
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: (dosYear << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  }
}

const encoder = new TextEncoder()

// ZIP local file header signature / central directory header signature /
// end-of-central-directory record signature.
const LFH_SIG = 0x04034b50
const CDH_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

// Version-needed-to-extract for stored entries (2.0).
const VERSION_STORED = 20
// General-purpose bit 11: the name is UTF-8. Set unconditionally — harmless
// for ASCII names, required for non-ASCII (the stored file names are
// free-text #422 and may be Indonesian).
const FLAG_UTF8 = 0x0800

type EmittedEntry = {
  name: Uint8Array
  crc: number
  size: number
  offset: number
  /** Where the next entry's local header starts (this header + its data). */
  nextOffset: number
  time: number
  date: number
}

/**
 * The archive as an async generator of byte chunks: one local header chunk,
 * one data chunk per entry, then the central directory + EOCD. Pulled
 * lazily — the caller's storage reads happen as the response body drains,
 * not up front.
 */
export async function* zipChunks(entries: AsyncIterable<ZipEntry>): AsyncGenerator<Uint8Array> {
  const emitted: EmittedEntry[] = []
  for await (const entry of entries) {
    const data = typeof entry.data === 'function' ? await entry.data() : entry.data
    const name = encoder.encode(entry.name)
    const { time, date } = dosDateTime(entry.modified ?? new Date())
    const crc = crc32(data)
    const offset = emitted.length === 0 ? 0 : emitted[emitted.length - 1].nextOffset

    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, LFH_SIG, true)
    view.setUint16(4, VERSION_STORED, true)
    view.setUint16(6, FLAG_UTF8, true)
    view.setUint16(8, 0, true) // method 0 = stored
    view.setUint16(10, time, true)
    view.setUint16(12, date, true)
    view.setUint32(14, crc, true)
    view.setUint32(18, data.length, true) // compressed size
    view.setUint32(22, data.length, true) // uncompressed size
    view.setUint16(26, name.length, true)
    view.setUint16(28, 0, true) // extra field length
    header.set(name, 30)
    yield header
    yield data

    emitted.push({
      name,
      crc,
      size: data.length,
      offset,
      time,
      date,
      nextOffset: offset + header.length + data.length,
    })
  }

  const cdStart = emitted.length === 0 ? 0 : emitted[emitted.length - 1].nextOffset
  let cdSize = 0
  const cdChunks: Uint8Array[] = []
  for (const entry of emitted) {
    const record = new Uint8Array(46 + entry.name.length)
    const view = new DataView(record.buffer)
    view.setUint32(0, CDH_SIG, true)
    view.setUint16(4, VERSION_STORED, true) // version made by
    view.setUint16(6, VERSION_STORED, true) // version needed
    view.setUint16(8, FLAG_UTF8, true)
    view.setUint16(10, 0, true) // method
    view.setUint16(12, entry.time, true)
    view.setUint16(14, entry.date, true)
    view.setUint32(16, entry.crc, true)
    view.setUint32(20, entry.size, true)
    view.setUint32(24, entry.size, true)
    view.setUint16(28, entry.name.length, true)
    view.setUint16(30, 0, true) // extra length
    view.setUint16(32, 0, true) // comment length
    view.setUint16(34, 0, true) // disk number start
    view.setUint16(36, 0, true) // internal attributes
    view.setUint32(38, 0, true) // external attributes
    view.setUint32(42, entry.offset, true)
    record.set(entry.name, 46)
    cdChunks.push(record)
    cdSize += record.length
  }
  for (const chunk of cdChunks) yield chunk

  const eocd = new Uint8Array(22)
  const view = new DataView(eocd.buffer)
  view.setUint32(0, EOCD_SIG, true)
  view.setUint16(4, 0, true) // this disk
  view.setUint16(6, 0, true) // start disk
  view.setUint16(8, emitted.length, true)
  view.setUint16(10, emitted.length, true)
  view.setUint32(12, cdSize, true)
  view.setUint32(16, cdStart, true)
  view.setUint16(20, 0, true) // comment length
  yield eocd
}

/**
 * The export response body: a ReadableStream that pulls `zipChunks` one
 * yielded chunk at a time. `cancel` closes the generator so an aborted
 * download stops pulling storage reads (the R2 gets behind the loaders).
 */
export function zipStream(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>
): ReadableStream<Uint8Array> {
  // Sync entry arrays (the metadata-heavy happy path) normalize to the
  // async form the generator iterates; loaders make them pull-lazy either
  // way.
  const source =
    Symbol.asyncIterator in entries
      ? (entries as AsyncIterable<ZipEntry>)
      : (async function* () {
          yield* entries as Iterable<ZipEntry>
        })()
  const iterator = zipChunks(source)[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done) {
        controller.close()
        return
      }
      controller.enqueue(next.value)
    },
    async cancel() {
      await iterator.return(undefined)
    },
  })
}
