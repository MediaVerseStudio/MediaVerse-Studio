package studio.mediaverse.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DlnaTest {
    private val description = """
        <root xmlns="urn:schemas-upnp-org:device-1-0"><URLBase>http://192.168.1.20:9197/</URLBase><device>
        <friendlyName>[TV] Samsung &amp; Co</friendlyName><manufacturer>Samsung</manufacturer><modelName>QN65S95F</modelName><UDN>uuid:abc</UDN>
        <serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/upnp/control/RenderingControl1</controlURL></service>
        <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/upnp/control/AVTransport1</controlURL></service>
        </serviceList></device></root>
    """.trimIndent()

    @Test
    fun anSsdpAnswerGivesItsHeaders() {
        val headers = Dlna.parseSsdpReply("HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.20:9197/dmr\r\nST: x\r\n\r\n")
        assertEquals("http://192.168.1.20:9197/dmr", headers?.get("location"))
        assertNull(Dlna.parseSsdpReply("NOTIFY * HTTP/1.1\r\n\r\n"))
    }

    @Test
    fun aDescriptionGivesNameAndControlAddress() {
        val renderer = Dlna.parseDescription(description, "http://192.168.1.20:9197/dmr")
        assertNotNull(renderer)
        assertEquals("[TV] Samsung & Co", renderer!!.name)
        assertEquals("Samsung QN65S95F", renderer.model)
        assertEquals("http://192.168.1.20:9197/upnp/control/AVTransport1", renderer.control)
        assertEquals("192.168.1.20", renderer.host)
    }

    @Test
    fun aDescriptionSendingThePhoneToAnotherHostIsRefused() {
        assertNull(Dlna.parseDescription(description.replace("/upnp/control/AVTransport1", "http://10.0.0.9/evil"), "http://192.168.1.20:9197/dmr"))
        assertNull(Dlna.parseDescription(description.replace("AVTransport", "Other"), "http://192.168.1.20:9197/dmr"))
    }

    @Test
    fun theVolumeServiceIsFoundOnTheSameHostOnly() {
        val renderer = Dlna.parseDescription(description, "http://192.168.1.20:9197/dmr")!!
        assertEquals("http://192.168.1.20:9197/upnp/control/RenderingControl1", renderer.rendering)
        val evil = Dlna.parseDescription(description.replace("/upnp/control/RenderingControl1", "http://10.0.0.9/x"), "http://192.168.1.20:9197/dmr")!!
        assertNull(evil.rendering)
        assertNull(Dlna.parseDescription(description.replace("RenderingControl", "Other"), "http://192.168.1.20:9197/dmr")!!.rendering)
    }

    @Test
    fun volumeIsWholePercentsInsideTheRange() {
        assertEquals(0, Dlna.volumeToPercent(-1.0))
        assertEquals(35, Dlna.volumeToPercent(0.346))
        assertEquals(100, Dlna.volumeToPercent(7.0))
        assertEquals(0.5, Dlna.percentToVolume(50.0), 0.0001)
    }

    @Test
    fun timesGoBothWays() {
        assertEquals("0:03:21", Dlna.upnpTime(201.4))
        assertEquals(201.0, Dlna.parseUpnpTime("0:03:21"), 0.001)
        assertEquals(201.5, Dlna.parseUpnpTime("00:03:21.500"), 0.001)
        assertEquals(0.0, Dlna.parseUpnpTime("NOT_IMPLEMENTED"), 0.001)
    }

    @Test
    fun theSongDescriptionIsEscapedAndCarriesTheCover() {
        val xml = Dlna.didl(CastSong("http://192.168.68.50:47700/api/audio/1?cast=t", "audio/mpeg", "Rock & <Roll>", "Band", "Album", "http://x/cover", 201.0))
        assertTrue(xml.contains("<dc:title>Rock &amp; &lt;Roll&gt;</dc:title>"))
        assertTrue(xml.contains("<upnp:albumArtURI>http://x/cover</upnp:albumArtURI>"))
        assertTrue(xml.contains("duration=\"0:03:21.000\""))
        assertTrue(xml.contains("DLNA.ORG_PN=MP3;"))
    }

    @Test
    fun theSoapBodyNamesTheActionAndService() {
        val body = Dlna.soapBody(Dlna.AV_TRANSPORT, "Seek", listOf("InstanceID" to "0", "Target" to "0:00:05"))
        assertTrue(body.contains("<u:Seek xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><Target>0:00:05</Target></u:Seek>"))
    }
}
