package studio.mediaverse.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream
import java.nio.charset.Charset

/**
 * Lyrics saved inside a song's own tags, read without any library: MP3 (ID3v2: SYLT synced, USLT plain), FLAC
 * (Vorbis comment LYRICS / UNSYNCEDLYRICS / SYNCEDLYRICS) and M4A/MP4 (©lyr). Plain lyrics written in the common
 * "[mm:ss.xx] words" style are shown as synced. Reading is cheap (a few kilobytes, pictures are skipped) and runs per song
 * when asked. The format matches the desktop's `TrackLyrics` (plain, synced, lines, source) so the same screens work.
 */
object Lyrics {
    data class Line(val ms: Long, val text: String)
    data class Found(val plain: String?, val lines: List<Line>) {
        val synced: Boolean get() = lines.isNotEmpty()
        fun toJson(): JSONObject = JSONObject()
            .put("plain", plain ?: JSONObject.NULL)
            .put("synced", synced)
            .put("lines", JSONArray().also { array -> lines.forEach { array.put(JSONObject().put("ms", it.ms).put("text", it.text)) } })
            .put("source", "tag")

        /**
         * The lyrics as the MediaVerse Cast receiver page takes them, kept small: the same shape and limits the desktop
         * program sends (at most 400 lines of 200 characters, 20,000 characters of plain words), so a TV shows the same
         * lyrics whichever of the two is casting.
         */
        fun toCastJson(): JSONObject = JSONObject()
            .put("synced", synced)
            .put("lines", JSONArray().also { array -> lines.take(400).forEach { array.put(JSONObject().put("ms", it.ms).put("text", it.text.take(200))) } })
            .put("plain", (plain ?: "").take(20_000))
    }

    val none: JSONObject get() = JSONObject().put("plain", JSONObject.NULL).put("synced", false).put("lines", JSONArray()).put("source", JSONObject.NULL)

    private const val MAX_TAG = 8 * 1024 * 1024

    /** The lyrics of a library song, or null when it has none (or the file cannot be read). */
    fun read(context: Context, track: Track): Found? =
        runCatching { context.contentResolver.openInputStream(track.uri)?.use { read(it) } }.getOrNull()

    /** The lyrics in a song file's bytes, whichever of the supported formats it is. */
    fun read(raw: InputStream): Found? {
        val input = BufferedInputStream(raw, 64 * 1024)
        input.mark(16)
        val head = ByteArray(12)
        val got = readUpTo(input, head)
        input.reset()
        return when {
            got >= 10 && head[0] == 'I'.code.toByte() && head[1] == 'D'.code.toByte() && head[2] == '3'.code.toByte() -> readId3(input)
            got >= 4 && String(head, 0, 4, Charsets.ISO_8859_1) == "fLaC" -> readFlac(input)
            got >= 8 && String(head, 4, 4, Charsets.ISO_8859_1) == "ftyp" -> readMp4(input)
            else -> null
        }
    }

    // ---------- common ----------

    private fun readUpTo(input: InputStream, buffer: ByteArray): Int {
        var total = 0
        while (total < buffer.size) {
            val n = input.read(buffer, total, buffer.size - total)
            if (n < 0) break
            total += n
        }
        return total
    }

    private fun readFully(input: InputStream, count: Int): ByteArray {
        val buffer = ByteArray(count)
        if (readUpTo(input, buffer) < count) throw EOFException()
        return buffer
    }

    private fun skipFully(input: InputStream, count: Long) {
        var left = count
        while (left > 0) {
            val skipped = input.skip(left)
            if (skipped > 0) left -= skipped
            else {
                if (input.read() < 0) throw EOFException()
                left--
            }
        }
    }

    private fun le32(b: ByteArray, at: Int): Long =
        (b[at].toLong() and 0xFF) or ((b[at + 1].toLong() and 0xFF) shl 8) or ((b[at + 2].toLong() and 0xFF) shl 16) or ((b[at + 3].toLong() and 0xFF) shl 24)

    private fun be32(b: ByteArray, at: Int): Long =
        ((b[at].toLong() and 0xFF) shl 24) or ((b[at + 1].toLong() and 0xFF) shl 16) or ((b[at + 2].toLong() and 0xFF) shl 8) or (b[at + 3].toLong() and 0xFF)

    private fun syncsafe(b: ByteArray, at: Int): Int =
        ((b[at].toInt() and 0x7F) shl 21) or ((b[at + 1].toInt() and 0x7F) shl 14) or ((b[at + 2].toInt() and 0x7F) shl 7) or (b[at + 3].toInt() and 0x7F)

    /** Plain text from a tag, with the lines of a "[mm:ss.xx] words" body turned into synced lines. */
    private fun fromText(text: String): Found? {
        val clean = text.replace("\u0000", "").trim()
        if (clean.isEmpty()) return null
        val lines = parseLrc(clean)
        return if (lines.isNotEmpty()) Found(lines.joinToString("\n") { it.text }, lines) else Found(clean, emptyList())
    }

    private fun better(a: Found?, b: Found?): Found? = when {
        a == null -> b
        b == null -> a
        a.synced != b.synced -> if (a.synced) a else b
        else -> a
    }

    /**
     * Lines of an LRC body: `[01:23.45] words`, several stamps for a repeated line, `[offset:+500]` honoured, other
     * `[ar:..]` tags ignored. Time order. Blank text is kept (it marks an instrumental gap).
     */
    fun parseLrc(text: String): List<Line> {
        val stamp = Regex("\\[(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?]")
        var offset = 0L
        val out = ArrayList<Line>()
        for (raw in text.replace("\r\n", "\n").replace('\r', '\n').split('\n')) {
            val line = raw.trim()
            Regex("^\\[offset:\\s*([+-]?\\d+)\\s*]", RegexOption.IGNORE_CASE).find(line)?.let { offset = it.groupValues[1].toLongOrNull() ?: 0L; return@let }
            val stamps = ArrayList<Long>()
            var rest = line
            while (true) {
                val m = stamp.find(rest)?.takeIf { it.range.first == 0 } ?: break
                val fraction = m.groupValues[3]
                val ms = m.groupValues[1].toLong() * 60_000 + m.groupValues[2].toLong() * 1000 +
                    (if (fraction.isEmpty()) 0L else (fraction + "00").take(3).toLong())
                stamps.add(ms)
                rest = rest.substring(m.range.last + 1)
            }
            if (stamps.isEmpty()) continue
            // Word-by-word stamps ("<00:12.30>") some files add inside a line are dropped.
            val words = rest.replace(Regex("<\\d{1,3}:\\d{1,2}(?:[.:]\\d{1,3})?>"), "").trim()
            for (ms in stamps) out.add(Line((ms + offset).coerceAtLeast(0), words))
        }
        return out.sortedBy { it.ms }
    }

    // ---------- ID3v2 (MP3) ----------

    private fun charsetFor(encoding: Int): Charset = when (encoding) {
        1 -> Charsets.UTF_16
        2 -> Charsets.UTF_16BE
        3 -> Charsets.UTF_8
        else -> Charsets.ISO_8859_1
    }

    /** Index of the end mark of the string starting at `from` (one zero byte, or an aligned pair for UTF-16), or -1. */
    private fun terminator(b: ByteArray, from: Int, encoding: Int): Int {
        if (encoding == 1 || encoding == 2) {
            var i = from
            while (i + 1 < b.size) {
                if (b[i].toInt() == 0 && b[i + 1].toInt() == 0) return i
                i += 2
            }
            return -1
        }
        for (i in from until b.size) if (b[i].toInt() == 0) return i
        return -1
    }

    private fun terminatorSize(encoding: Int) = if (encoding == 1 || encoding == 2) 2 else 1

    private fun decode(b: ByteArray, from: Int, to: Int, encoding: Int): String {
        if (to <= from) return ""
        var charset = charsetFor(encoding)
        var start = from
        // A UTF-16 string without its own byte-order mark (some writers) is taken as little endian.
        if (encoding == 1 && to - from >= 2) {
            val bom = (b[from].toInt() and 0xFF) shl 8 or (b[from + 1].toInt() and 0xFF)
            if (bom != 0xFEFF && bom != 0xFFFE) charset = Charsets.UTF_16LE
        }
        if (encoding == 3 && to - from >= 3 && b[from] == 0xEF.toByte() && b[from + 1] == 0xBB.toByte() && b[from + 2] == 0xBF.toByte()) start += 3
        return String(b, start, to - start, charset)
    }

    private fun deUnsync(b: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(b.size)
        var i = 0
        while (i < b.size) {
            out.write(b[i].toInt())
            if (b[i] == 0xFF.toByte() && i + 1 < b.size && b[i + 1].toInt() == 0) i++
            i++
        }
        return out.toByteArray()
    }

    private fun readId3(input: InputStream): Found? {
        val header = readFully(input, 10)
        val major = header[3].toInt()
        if (major !in 2..4) return null
        val flags = header[5].toInt()
        val size = syncsafe(header, 6)
        if (size <= 0 || size > MAX_TAG) return null
        var body = readFully(input, size)
        if (flags and 0x80 != 0 && major < 4) body = deUnsync(body)
        var pos = 0
        if (flags and 0x40 != 0 && major >= 3 && body.size >= 4) {
            pos = if (major == 4) syncsafe(body, 0) else (be32(body, 0) + 4).toInt()
            if (pos < 0 || pos > body.size) return null
        }
        val idSize = if (major == 2) 3 else 4
        val headSize = if (major == 2) 6 else 10
        var plain: Found? = null
        var synced: Found? = null
        while (pos + headSize <= body.size) {
            if (body[pos].toInt() == 0) break // padding
            val id = String(body, pos, idSize, Charsets.ISO_8859_1)
            val frameSize = when (major) {
                2 -> ((body[pos + 3].toInt() and 0xFF) shl 16) or ((body[pos + 4].toInt() and 0xFF) shl 8) or (body[pos + 5].toInt() and 0xFF)
                3 -> be32(body, pos + 4).toInt()
                else -> syncsafe(body, pos + 4)
            }
            val formatFlags = if (major == 2) 0 else body[pos + 9].toInt() and 0xFF
            var start = pos + headSize
            var end = start + frameSize
            if (frameSize < 0 || end > body.size) break
            pos = end
            if (id != "USLT" && id != "ULT" && id != "SYLT" && id != "SLT") continue
            var data = body.copyOfRange(start, end)
            if (major == 4) {
                if (formatFlags and 0x08 != 0 || formatFlags and 0x04 != 0) continue // compressed or encrypted
                if (formatFlags and 0x01 != 0 && data.size >= 4) data = data.copyOfRange(4, data.size)
                if (formatFlags and 0x02 != 0) data = deUnsync(data)
            } else if (major == 3) {
                if (formatFlags and 0xC0 != 0) continue
                if (formatFlags and 0x20 != 0 && data.isNotEmpty()) data = data.copyOfRange(1, data.size)
            }
            if (id == "USLT" || id == "ULT") plain = better(plain, parseUslt(data))
            else synced = better(synced, parseSylt(data))
        }
        return better(synced, plain)
    }

    private fun parseUslt(d: ByteArray): Found? {
        if (d.size < 5) return null
        val encoding = d[0].toInt()
        val end = terminator(d, 4, encoding)
        if (end < 0) return null
        return fromText(decode(d, end + terminatorSize(encoding), d.size, encoding))
    }

    private fun parseSylt(d: ByteArray): Found? {
        if (d.size < 7) return null
        val encoding = d[0].toInt()
        val format = d[4].toInt() // 2 = milliseconds; 1 = MPEG frames (cannot be placed without the audio, skipped)
        if (format != 2) return null
        val descEnd = terminator(d, 6, encoding)
        if (descEnd < 0) return null
        var pos = descEnd + terminatorSize(encoding)
        val lines = ArrayList<Line>()
        while (pos < d.size) {
            val end = terminator(d, pos, encoding)
            if (end < 0 || end + terminatorSize(encoding) + 4 > d.size) break
            val text = decode(d, pos, end, encoding).replace("\r", "").trimStart('\n').trimEnd('\n')
            val at = end + terminatorSize(encoding)
            lines.add(Line(be32(d, at), text))
            pos = at + 4
        }
        if (lines.isEmpty()) return null
        val sorted = lines.sortedBy { it.ms }
        return Found(sorted.joinToString("\n") { it.text }, sorted)
    }

    // ---------- FLAC (Vorbis comments) ----------

    private fun readFlac(input: InputStream): Found? {
        skipFully(input, 4)
        while (true) {
            val h = readFully(input, 4)
            val last = h[0].toInt() and 0x80 != 0
            val type = h[0].toInt() and 0x7F
            val length = ((h[1].toInt() and 0xFF) shl 16) or ((h[2].toInt() and 0xFF) shl 8) or (h[3].toInt() and 0xFF)
            if (type == 4) {
                if (length > MAX_TAG) return null
                return parseVorbisComments(readFully(input, length))
            }
            skipFully(input, length.toLong())
            if (last) return null
        }
    }

    /** Lyrics from a Vorbis comment block (also used by Ogg files): SYNCEDLYRICS first, then LYRICS / UNSYNCEDLYRICS. */
    fun parseVorbisComments(b: ByteArray): Found? {
        if (b.size < 8) return null
        var pos = 4 + le32(b, 0).toInt()
        if (pos < 0 || pos + 4 > b.size) return null
        val count = le32(b, pos)
        pos += 4
        var plain: Found? = null
        var synced: Found? = null
        var n = 0L
        while (n < count && pos + 4 <= b.size) {
            val len = le32(b, pos).toInt()
            pos += 4
            if (len < 0 || pos + len > b.size) break
            val entry = String(b, pos, len, Charsets.UTF_8)
            pos += len
            n++
            val eq = entry.indexOf('=')
            if (eq <= 0) continue
            val value = entry.substring(eq + 1)
            when (entry.substring(0, eq).uppercase()) {
                "SYNCEDLYRICS" -> synced = better(synced, fromText(value))
                "LYRICS", "UNSYNCEDLYRICS", "UNSYNCED LYRICS" -> plain = better(plain, fromText(value))
            }
        }
        return better(synced, plain)
    }

    // ---------- M4A / MP4 (©lyr) ----------

    private fun readMp4(input: InputStream): Found? {
        // Walk the top-level boxes to "moov", read it whole (it is small, the sound is in "mdat"), then find the lyrics.
        while (true) {
            val h = try { readFully(input, 8) } catch (_: EOFException) { return null }
            var size = be32(h, 0)
            val type = String(h, 4, 4, Charsets.ISO_8859_1)
            var header = 8L
            if (size == 1L) {
                val big = readFully(input, 8)
                size = (be32(big, 0) shl 32) or be32(big, 4)
                header = 16
            }
            if (size == 0L) return null
            val body = size - header
            if (type == "moov") {
                if (body > MAX_TAG) return null
                return findLyr(readFully(input, body.toInt()))
            }
            if (body < 0) return null
            skipFully(input, body)
        }
    }

    private fun findLyr(moov: ByteArray): Found? {
        // The item "©lyr" holds a "data" box: 8 bytes (type, locale) then the text. Searching for the name is enough.
        val key = byteArrayOf(0xA9.toByte(), 'l'.code.toByte(), 'y'.code.toByte(), 'r'.code.toByte())
        var i = 4
        while (i + 8 < moov.size) {
            if (moov[i] == key[0] && moov[i + 1] == key[1] && moov[i + 2] == key[2] && moov[i + 3] == key[3]) {
                val boxStart = i - 4
                val total = be32(moov, boxStart).toInt()
                val dataAt = i + 4
                if (total > 8 && dataAt + 16 <= moov.size && String(moov, dataAt + 4, 4, Charsets.ISO_8859_1) == "data") {
                    val dataSize = be32(moov, dataAt).toInt()
                    val textStart = dataAt + 16
                    val textEnd = (dataAt + dataSize).coerceAtMost(moov.size)
                    if (textEnd > textStart) return fromText(String(moov, textStart, textEnd - textStart, Charsets.UTF_8))
                }
            }
            i++
        }
        return null
    }
}
