package studio.mediaverse.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same rules as the computer's share server (web/app/electron/library-share.js and its tests). */
class ShareServerTest {
    @Test
    fun onlyHomeNetworkAddressesAreServed() {
        for (ok in listOf("192.168.1.20", "10.0.0.5", "172.16.3.4", "172.31.255.1", "127.0.0.1", "169.254.1.1", "::1", "::ffff:192.168.0.9", "fe80::1", "fd12:3456::1")) {
            assertTrue(ok, ShareServer.isHomeNetworkAddress(ok))
        }
        for (no in listOf("8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:4860::8888", "", "300.1.1.1", "::ffff:8.8.8.8")) {
            assertFalse(no, ShareServer.isHomeNetworkAddress(no))
        }
    }

    @Test
    fun byteRangesAreReadAsTheComputerReadsThem() {
        assertNull(ShareServer.parseRange(null, 100))
        assertNull("several ranges: the whole file", ShareServer.parseRange("bytes=0-1,5-6", 100))
        assertEquals(0L..99L, ShareServer.parseRange("bytes=0-", 100))
        assertEquals(10L..19L, ShareServer.parseRange("bytes=10-19", 100))
        assertEquals(90L..99L, ShareServer.parseRange("bytes=-10", 100))
        assertEquals(50L..99L, ShareServer.parseRange("bytes=50-500", 100))
        assertTrue("past the end", ShareServer.parseRange("bytes=100-", 100)!!.isEmpty())
        assertTrue("empty", ShareServer.parseRange("bytes=-", 100)!!.isEmpty())
    }

    @Test
    fun keysAreKeptAsTheirSha256() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", ShareServer.keyHash(""))
    }
}
