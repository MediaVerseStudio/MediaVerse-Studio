package studio.mediaverse.app

import java.io.ByteArrayOutputStream

/**
 * The Google Cast "CastMessage" protocol buffer and its framing, written here (no component), as in the computer's
 * web/app/electron/googlecast.js: fields 1 to 6 (enums and strings only), each message sent after a 4-byte big-endian
 * length. Pure, so it is unit tested.
 */
object CastWire {
    data class Message(val source: String, val destination: String, val namespace: String, val text: String?, val binary: Boolean)

    private fun varint(value: Long, out: ByteArrayOutputStream) {
        var v = value
        while (v > 0x7f) {
            out.write(((v and 0x7f) or 0x80).toInt())
            v = v ushr 7
        }
        out.write(v.toInt())
    }

    private fun number(out: ByteArrayOutputStream, field: Int, value: Long) {
        varint((field shl 3).toLong(), out)
        varint(value, out)
    }

    private fun string(out: ByteArrayOutputStream, field: Int, value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        varint(((field shl 3) or 2).toLong(), out)
        varint(bytes.size.toLong(), out)
        out.write(bytes)
    }

    /** A message to `destination` on `namespace` carrying JSON (or other) text. */
    fun encode(destination: String, namespace: String, text: String, source: String = "sender-0"): ByteArray {
        val out = ByteArrayOutputStream()
        number(out, 1, 0) // protocol version CASTV2_1_0
        string(out, 2, source)
        string(out, 3, destination)
        string(out, 4, namespace)
        number(out, 5, 0) // payload type: string
        string(out, 6, text)
        return out.toByteArray()
    }

    private class Reader(val bytes: ByteArray) {
        var at = 0
        fun varint(): Long {
            var value = 0L
            var shift = 0
            while (true) {
                if (at >= bytes.size) throw IllegalArgumentException("truncated message")
                val b = bytes[at++].toInt() and 0xff
                value += (b and 0x7f).toLong() shl shift
                if (b and 0x80 == 0) return value
                shift += 7
                if (shift > 49) throw IllegalArgumentException("bad number")
            }
        }
    }

    fun decode(bytes: ByteArray): Message {
        val reader = Reader(bytes)
        var source = ""
        var destination = ""
        var namespace = ""
        var text: String? = null
        var binary = false
        while (reader.at < bytes.size) {
            val key = reader.varint()
            val field = (key shr 3).toInt()
            when ((key and 7).toInt()) {
                0 -> {
                    val value = reader.varint()
                    if (field == 5) binary = value == 1L
                }
                2 -> {
                    val length = reader.varint().toInt()
                    if (length < 0 || reader.at + length > bytes.size) throw IllegalArgumentException("truncated message")
                    val s = String(bytes, reader.at, length, Charsets.UTF_8)
                    reader.at += length
                    when (field) {
                        2 -> source = s
                        3 -> destination = s
                        4 -> namespace = s
                        6 -> text = s
                    }
                }
                else -> throw IllegalArgumentException("unexpected field type")
            }
        }
        return Message(source, destination, namespace, text, binary)
    }

    fun frame(payload: ByteArray): ByteArray {
        val n = payload.size
        return byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte()) + payload
    }

    /** Splits a byte stream into length-prefixed messages and hands over each complete one. */
    class Framer(private val onMessage: (ByteArray) -> Unit) {
        private var pending = ByteArray(0)

        fun feed(chunk: ByteArray, length: Int = chunk.size) {
            pending += chunk.copyOf(length)
            while (pending.size >= 4) {
                val size = ((pending[0].toInt() and 0xff) shl 24) or ((pending[1].toInt() and 0xff) shl 16) or ((pending[2].toInt() and 0xff) shl 8) or (pending[3].toInt() and 0xff)
                if (size < 0 || size > 1024 * 1024) throw IllegalArgumentException("message too large")
                if (pending.size < 4 + size) break
                onMessage(pending.copyOfRange(4, 4 + size))
                pending = pending.copyOfRange(4 + size, pending.size)
            }
        }
    }
}
