package studio.mediaverse.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class CastWireTest {
    @Test
    fun aMessageSurvivesEncodingAndDecoding() {
        val text = """{"type":"LOAD","title":"Café ♪"}"""
        val message = CastWire.decode(CastWire.encode("receiver-0", "urn:x-cast:com.google.cast.media", text))
        assertEquals("sender-0", message.source)
        assertEquals("receiver-0", message.destination)
        assertEquals("urn:x-cast:com.google.cast.media", message.namespace)
        assertEquals(text, message.text)
        assertFalse(message.binary)
    }

    @Test
    fun longTextsUseMultiByteLengths() {
        val text = "x".repeat(70_000)
        assertEquals(text, CastWire.decode(CastWire.encode("a", "b", text)).text)
    }

    @Test
    fun theFramerSplitsAndJoinsMessages() {
        val got = ArrayList<String>()
        val framer = CastWire.Framer { got += CastWire.decode(it).text ?: "" }
        val stream = CastWire.frame(CastWire.encode("d", "n", "one")) + CastWire.frame(CastWire.encode("d", "n", "two"))
        for (b in stream) framer.feed(byteArrayOf(b)) // one byte at a time
        assertEquals(listOf("one", "two"), got)
    }

    @Test
    fun theFrameHasAFourByteLength() {
        val framed = CastWire.frame(byteArrayOf(1, 2, 3))
        assertArrayEquals(byteArrayOf(0, 0, 0, 3, 1, 2, 3), framed)
    }

    @Test
    fun brokenMessagesAreRefused() {
        assertThrows(IllegalArgumentException::class.java) { CastWire.decode(byteArrayOf(0x12, 0x7f, 1)) }
        assertThrows(IllegalArgumentException::class.java) { CastWire.Framer { }.feed(byteArrayOf(0x7f, 0, 0, 0)) }
    }
}
