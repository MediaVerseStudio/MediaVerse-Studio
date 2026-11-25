package studio.mediaverse.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

class HomeHttpTest {
    private fun home(text: String) = HomeHttp.isHomeAddress(InetAddress.getByName(text))

    @Test
    fun homeNetworkAddressesAreAllowed() {
        assertTrue(home("192.168.1.20"))
        assertTrue(home("10.0.0.5"))
        assertTrue(home("172.16.4.4"))
        assertTrue(home("127.0.0.1"))
        assertTrue(home("fd12:3456:789a::1"))
    }

    @Test
    fun theInternetIsRefused() {
        assertFalse(home("8.8.8.8"))
        assertFalse(home("172.32.0.1"))
        assertFalse(home("2001:4860:4860::8888"))
    }
}
