// Reading song details from the start of a music file on the TV (USB drives): ID3v2 tags (MP3) and FLAC
// Vorbis comments, plus the embedded front cover. Only what the TV app shows is read; anything unusual is
// skipped rather than guessed. When a file has no readable tags, `fromFileName` names it from its folders.

export type FileTags = {
  title?: string;
  artist?: string;
  album?: string;
  album_artist?: string;
  genre?: string;
  year?: number;
  track_number?: number;
  picture?: { mime: string; data: Uint8Array };
};

/** How many bytes from the start of the file hold the tags, given its first 10 bytes; null if not tagged. */
export function tagLength(head: Uint8Array): number | null {
  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    return 10 + synchsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
  }
  if (head.length >= 4 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
    return -1; // FLAC: the blocks have to be walked; the caller reads a generous amount
  }
  return null;
}

function synchsafe(bytes: Uint8Array, at: number): number {
  return ((bytes[at] & 0x7f) << 21) | ((bytes[at + 1] & 0x7f) << 14) | ((bytes[at + 2] & 0x7f) << 7) | (bytes[at + 3] & 0x7f);
}

function bigEndian(bytes: Uint8Array, at: number, count: number): number {
  let value = 0;
  for (let i = 0; i < count; i++) value = value * 256 + bytes[at + i];
  return value;
}

function littleEndian32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 0x1000000;
}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");
const utf16le = new TextDecoder("utf-16le");
const utf16be = new TextDecoder("utf-16be");

/** An ID3 text frame's value (first string only), by its encoding byte. */
function id3Text(frame: Uint8Array): string {
  if (!frame.length) return "";
  const encoding = frame[0];
  let body = frame.subarray(1);
  let text: string;
  if (encoding === 1 || encoding === 2) {
    let decoder = encoding === 2 ? utf16be : utf16le;
    if (body[0] === 0xfe && body[1] === 0xff) decoder = utf16be;
    if ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff)) body = body.subarray(2);
    text = decoder.decode(body.subarray(0, body.length - (body.length % 2)));
  } else {
    text = (encoding === 3 ? utf8 : latin1).decode(body);
  }
  return text.split("\u0000")[0].trim();
}

const ID3_FIELDS: Record<string, keyof FileTags> = {
  TIT2: "title", TT2: "title",
  TPE1: "artist", TP1: "artist",
  TALB: "album", TAL: "album",
  TPE2: "album_artist", TP2: "album_artist",
  TCON: "genre", TCO: "genre",
  TRCK: "track_number", TRK: "track_number",
  TYER: "year", TYE: "year", TDRC: "year", TDOR: "year",
};

function setField(tags: FileTags, field: keyof FileTags, value: string): void {
  if (!value) return;
  if (field === "year") {
    const year = Number(/\d{4}/.exec(value)?.[0]);
    if (year && !tags.year) tags.year = year;
  } else if (field === "track_number") {
    const number = parseInt(value, 10);
    if (number > 0) tags.track_number = number;
  } else if (field === "genre") {
    tags.genre = value.replace(/^\((\d+)\)$/, "").trim() || undefined; // bare ID3v1 genre numbers are dropped
  } else if (field !== "picture") {
    (tags as Record<string, unknown>)[field] = value;
  }
}

function parseId3(bytes: Uint8Array): FileTags {
  const tags: FileTags = {};
  const version = bytes[3];
  const flags = bytes[5];
  const end = Math.min(bytes.length, 10 + synchsafe(bytes, 6));
  if (flags & 0x80 && version < 4) return tags; // whole-tag unsynchronisation (rare): not handled
  let at = 10;
  if (flags & 0x40) at += version >= 4 ? synchsafe(bytes, 10) : 4 + bigEndian(bytes, 10, 4); // extended header
  const idLength = version === 2 ? 3 : 4;
  const header = version === 2 ? 6 : 10;
  while (at + header <= end) {
    const id = latin1.decode(bytes.subarray(at, at + idLength));
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const size = version === 2 ? bigEndian(bytes, at + 3, 3) : version >= 4 ? synchsafe(bytes, at + 4) : bigEndian(bytes, at + 4, 4);
    const start = at + header;
    if (size <= 0 || start + size > end) break;
    const frame = bytes.subarray(start, start + size);
    const field = ID3_FIELDS[id];
    if (field) setField(tags, field, id3Text(frame));
    else if ((id === "APIC" || id === "PIC") && !tags.picture) tags.picture = id3Picture(frame, version === 2);
    at = start + size;
  }
  return tags;
}

/** The picture in an APIC (or v2.2 PIC) frame, preferring nothing: the first picture is taken. */
function id3Picture(frame: Uint8Array, old: boolean): FileTags["picture"] {
  const encoding = frame[0];
  let at = 1;
  let mime: string;
  if (old) {
    mime = latin1.decode(frame.subarray(1, 4)).toUpperCase() === "PNG" ? "image/png" : "image/jpeg";
    at = 4;
  } else {
    const zero = frame.indexOf(0, 1);
    if (zero < 0) return undefined;
    mime = latin1.decode(frame.subarray(1, zero)).toLowerCase();
    if (!mime.includes("/")) mime = `image/${mime || "jpeg"}`;
    at = zero + 1;
  }
  at += 1; // picture type
  // The description ends with one zero byte, or two for UTF-16.
  if (encoding === 1 || encoding === 2) {
    while (at + 1 < frame.length && !(frame[at] === 0 && frame[at + 1] === 0)) at += 2;
    at += 2;
  } else {
    while (at < frame.length && frame[at] !== 0) at += 1;
    at += 1;
  }
  if (at >= frame.length || (mime !== "image/jpeg" && mime !== "image/jpg" && mime !== "image/png")) return undefined;
  return { mime: mime === "image/jpg" ? "image/jpeg" : mime, data: frame.subarray(at) };
}

const VORBIS_FIELDS: Record<string, keyof FileTags> = {
  TITLE: "title",
  ARTIST: "artist",
  ALBUM: "album",
  ALBUMARTIST: "album_artist",
  "ALBUM ARTIST": "album_artist",
  GENRE: "genre",
  TRACKNUMBER: "track_number",
  DATE: "year",
  YEAR: "year",
  ORIGINALDATE: "year",
};

function parseFlac(bytes: Uint8Array): FileTags {
  const tags: FileTags = {};
  let at = 4;
  while (at + 4 <= bytes.length) {
    const last = (bytes[at] & 0x80) !== 0;
    const type = bytes[at] & 0x7f;
    const length = bigEndian(bytes, at + 1, 3);
    const start = at + 4;
    if (start + length > bytes.length) break;
    const block = bytes.subarray(start, start + length);
    if (type === 4) {
      let p = 4 + littleEndian32(block, 0); // vendor string
      const count = littleEndian32(block, p);
      p += 4;
      for (let i = 0; i < count && p + 4 <= block.length; i++) {
        const size = littleEndian32(block, p);
        const entry = utf8.decode(block.subarray(p + 4, p + 4 + size));
        p += 4 + size;
        const equals = entry.indexOf("=");
        const field = VORBIS_FIELDS[entry.slice(0, equals).toUpperCase()];
        if (equals > 0 && field) setField(tags, field, entry.slice(equals + 1).trim());
      }
    } else if (type === 6 && !tags.picture) {
      let p = 4;
      const mimeLength = bigEndian(block, p, 4);
      const mime = latin1.decode(block.subarray(p + 4, p + 4 + mimeLength)).toLowerCase();
      p += 4 + mimeLength;
      p += 4 + bigEndian(block, p, 4); // description
      p += 16; // width, height, depth, colours
      const size = bigEndian(block, p, 4);
      if ((mime === "image/jpeg" || mime === "image/png") && p + 4 + size <= block.length) tags.picture = { mime, data: block.subarray(p + 4, p + 4 + size) };
    }
    if (last) break;
    at = start + length;
  }
  return tags;
}

/** Song details from the start of a file (as much of it as `tagLength` asked for). */
export function readTags(bytes: Uint8Array): FileTags {
  try {
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return parseId3(bytes);
    if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return parseFlac(bytes);
  } catch {
    // damaged tags: fall back to the file name
  }
  return {};
}

/** "Artist/Album/03 - Song.mp3" (relative to the drive) as details, for files without tags. */
export function fromFileName(relativePath: string): FileTags {
  const parts = relativePath.split("/").filter(Boolean);
  const file = parts[parts.length - 1] ?? "";
  const stem = file.replace(/\.[^.]+$/, "");
  const match = /^(\d{1,3})(?:\s*[-.)_]\s*|\s+)(.+)$/.exec(stem);
  return {
    title: (match ? match[2] : stem).trim() || file,
    track_number: match ? Number(match[1]) : undefined,
    album: parts.length >= 2 ? parts[parts.length - 2] : undefined,
    artist: parts.length >= 3 ? parts[parts.length - 3] : undefined,
  };
}
