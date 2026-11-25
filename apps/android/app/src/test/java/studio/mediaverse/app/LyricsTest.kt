package studio.mediaverse.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class LyricsTest {
    private fun syncsafe(n: Int) = byteArrayOf(((n shr 21) and 0x7F).toByte(), ((n shr 14) and 0x7F).toByte(), ((n shr 7) and 0x7F).toByte(), (n and 0x7F).toByte())
    private fun be32(n: Long) = byteArrayOf((n shr 24).toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte())
    private fun le32(n: Int) = byteArrayOf(n.toByte(), (n shr 8).toByte(), (n shr 16).toByte(), (n shr 24).toByte())

    private fun frame(id: String, data: ByteArray, major: Int): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(id.toByteArray())
        out.write(if (major == 4) syncsafe(data.size) else be32(data.size.toLong()))
        out.write(byteArrayOf(0, 0))
        out.write(data)
        return out.toByteArray()
    }

    private fun id3(major: Int, vararg frames: ByteArray): ByteArray {
        val body = ByteArrayOutputStream()
        frames.forEach { body.write(it) }
        body.write(ByteArray(20)) // padding
        val out = ByteArrayOutputStream()
        out.write("ID3".toByteArray())
        out.write(byteArrayOf(major.toByte(), 0, 0))
        out.write(syncsafe(body.size()))
        out.write(body.toByteArray())
        out.write(ByteArray(100) { 0x55 }) // pretend audio
        return out.toByteArray()
    }

    private fun uslt(text: String, encoding: Int = 3): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(encoding)
        out.write("eng".toByteArray())
        out.write(if (encoding == 1 || encoding == 2) byteArrayOf(0, 0) else byteArrayOf(0)) // empty descriptor
        out.write(when (encoding) {
            1 -> byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + text.toByteArray(Charsets.UTF_16LE)
            else -> text.toByteArray(Charsets.UTF_8)
        })
        return out.toByteArray()
    }

    private fun sylt(vararg lines: Pair<Long, String>): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(3) // UTF-8
        out.write("eng".toByteArray())
        out.write(2) // milliseconds
        out.write(1) // lyrics
        out.write(0) // empty descriptor
        for ((ms, text) in lines) {
            out.write(text.toByteArray(Charsets.UTF_8))
            out.write(0)
            out.write(be32(ms))
        }
        return out.toByteArray()
    }

    @Test
    fun parsesLrcStampsOffsetsAndRepeats() {
        val lines = Lyrics.parseLrc("[ar:Someone]\n[offset:+500]\n[00:12.50]First\n[01:00.00][02:00.5]Chorus\n[00:30]Second")
        assertEquals(listOf(13_000L, 30_500L, 60_500L, 121_000L), lines.map { it.ms })
        assertEquals(listOf("First", "Second", "Chorus", "Chorus"), lines.map { it.text })
    }

    @Test
    fun plainTextWithoutStampsIsNotSynced() {
        assertTrue(Lyrics.parseLrc("Just words\nand more words").isEmpty())
    }

    @Test
    fun readsPlainLyricsFromId3v24() {
        val found = Lyrics.read(ByteArrayInputStream(id3(4, frame("USLT", uslt("Line one\nLine two"), 4))))
        assertNotNull(found)
        assertFalse(found!!.synced)
        assertEquals("Line one\nLine two", found.plain)
    }

    @Test
    fun readsUtf16LyricsFromId3v23() {
        val found = Lyrics.read(ByteArrayInputStream(id3(3, frame("USLT", uslt("Héllo wörld", 1), 3))))
        assertEquals("Héllo wörld", found!!.plain)
    }

    @Test
    fun syncedFrameWinsOverPlainAndKeepsTimes() {
        val bytes = id3(4, frame("USLT", uslt("plain version"), 4), frame("SYLT", sylt(2000L to "Two", 500L to "One"), 4))
        val found = Lyrics.read(ByteArrayInputStream(bytes))!!
        assertTrue(found.synced)
        assertEquals(listOf(500L, 2000L), found.lines.map { it.ms })
        assertEquals(listOf("One", "Two"), found.lines.map { it.text })
    }

    @Test
    fun plainLyricsHoldingLrcStampsCountAsSynced() {
        val found = Lyrics.read(ByteArrayInputStream(id3(4, frame("USLT", uslt("[00:01.00]Hello\n[00:03.00]World"), 4))))!!
        assertTrue(found.synced)
        assertEquals(listOf(1000L, 3000L), found.lines.map { it.ms })
    }

    @Test
    fun aSongWithNoLyricsGivesNull() {
        assertNull(Lyrics.read(ByteArrayInputStream(id3(4, frame("TIT2", byteArrayOf(3) + "Title".toByteArray(), 4)))))
        assertNull(Lyrics.read(ByteArrayInputStream(ByteArray(50))))
    }

    private fun flac(vararg comments: String, pictureBytes: Int = 2000): ByteArray {
        val vorbis = ByteArrayOutputStream()
        val vendor = "test".toByteArray()
        vorbis.write(le32(vendor.size)); vorbis.write(vendor)
        vorbis.write(le32(comments.size))
        comments.forEach { val b = it.toByteArray(Charsets.UTF_8); vorbis.write(le32(b.size)); vorbis.write(b) }
        val out = ByteArrayOutputStream()
        out.write("fLaC".toByteArray())
        out.write(byteArrayOf(0, 0, 0, 34)); out.write(ByteArray(34)) // STREAMINFO
        out.write(byteArrayOf(6, (pictureBytes shr 16).toByte(), (pictureBytes shr 8).toByte(), pictureBytes.toByte())); out.write(ByteArray(pictureBytes)) // PICTURE
        val v = vorbis.toByteArray()
        out.write(byteArrayOf((0x80 or 4).toByte(), (v.size shr 16).toByte(), (v.size shr 8).toByte(), v.size.toByte())); out.write(v)
        return out.toByteArray()
    }

    @Test
    fun readsFlacCommentsAndSkipsPictures() {
        val found = Lyrics.read(ByteArrayInputStream(flac("TITLE=X", "lyrics=Sing\nalong")))!!
        assertEquals("Sing\nalong", found.plain)
        assertFalse(found.synced)
    }

    @Test
    fun flacSyncedLyricsAreUsedWhenPresent() {
        val found = Lyrics.read(ByteArrayInputStream(flac("UNSYNCEDLYRICS=plain", "SYNCEDLYRICS=[00:05.00]Five")))!!
        assertTrue(found.synced)
        assertEquals(5000L, found.lines[0].ms)
    }

    @Test
    fun readsM4aLyrics() {
        fun box(type: ByteArray, payload: ByteArray) = be32((payload.size + 8).toLong()) + type + payload
        val text = "Mp4 words".toByteArray()
        val data = box("data".toByteArray(), byteArrayOf(0, 0, 0, 1, 0, 0, 0, 0) + text)
        val lyr = box(byteArrayOf(0xA9.toByte(), 'l'.code.toByte(), 'y'.code.toByte(), 'r'.code.toByte()), data)
        val ilst = box("ilst".toByteArray(), lyr)
        val moov = box("moov".toByteArray(), box("udta".toByteArray(), box("meta".toByteArray(), byteArrayOf(0, 0, 0, 0) + ilst)))
        val ftyp = box("ftyp".toByteArray(), "M4A \u0000\u0000\u0000\u0000".toByteArray())
        val found = Lyrics.read(ByteArrayInputStream(ftyp + box("free".toByteArray(), ByteArray(30)) + moov))!!
        assertEquals("Mp4 words", found.plain)
    }
}
