package studio.mediaverse.app

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URL

/**
 * DLNA / UPnP casting, ported from the computer's web/app/electron/dlna.js: SSDP to find MediaRenderers (Samsung TVs
 * without the MediaVerse app, many speakers and amplifiers), their description XML, and the standard AVTransport SOAP
 * actions. No component. Only devices on the home network are spoken to, and only at the address they answered from.
 * The text rules here are pure and unit tested.
 */
object Dlna {
    private const val SSDP_ADDRESS = "239.255.255.250"
    private const val SSDP_PORT = 1900
    const val AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1"
    private const val MAX_REPLY = 512 * 1024

    const val RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1"

    /** `rendering` is the RenderingControl control address (volume), null when the device offers none. */
    data class Renderer(val id: String, val name: String, val model: String, val host: String, val control: String, val service: String, val rendering: String? = null, val renderingService: String = RENDERING_CONTROL)

    fun searchMessage(mx: Int = 2): String = listOf(
        "M-SEARCH * HTTP/1.1", "HOST: $SSDP_ADDRESS:$SSDP_PORT", "MAN: \"ssdp:discover\"", "MX: $mx",
        "ST: urn:schemas-upnp-org:device:MediaRenderer:1", "USER-AGENT: MediaVerseStudio/1 UPnP/1.1", "", "",
    ).joinToString("\r\n")

    /** Headers of an SSDP answer, lower-cased names; null when it is not an HTTP 200 answer. */
    fun parseSsdpReply(text: String): Map<String, String>? {
        val lines = text.split(Regex("\r?\n"))
        if (!Regex("^HTTP/1\\.[01] 200", RegexOption.IGNORE_CASE).containsMatchIn(lines.firstOrNull() ?: "")) return null
        val headers = HashMap<String, String>()
        for (line in lines.drop(1)) {
            val at = line.indexOf(':')
            if (at > 0) headers[line.substring(0, at).trim().lowercase()] = line.substring(at + 1).trim()
        }
        return headers
    }

    fun decode(text: String): String = text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")
        .replace(Regex("&#(\\d+);")) { String(Character.toChars(it.groupValues[1].toInt())) }.replace("&amp;", "&")

    fun escapeXml(text: String?): String = (text ?: "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&apos;")

    /** The first `<tag>…</tag>` in `xml` (any namespace prefix), decoded; null when missing. */
    fun tag(xml: String, name: String): String? {
        val match = Regex("<(?:[\\w-]+:)?$name(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?$name>", RegexOption.IGNORE_CASE).find(xml) ?: return null
        return decode(match.groupValues[1].trim())
    }

    /**
     * A device description (the XML at an SSDP answer's LOCATION): its name and AVTransport control address. Null when
     * it cannot play (no AVTransport), or when the control address is on another host than `location` (a description
     * must not send the phone elsewhere).
     */
    fun parseDescription(xml: String, location: String): Renderer? {
        return runCatching {
            val where = URI(location)
            val base = URI(tag(xml, "URLBase")?.takeIf { it.isNotBlank() } ?: location)
            val services = Regex("<service>([\\s\\S]*?)</service>", RegexOption.IGNORE_CASE).findAll(xml).map { it.groupValues[1] }.toList()
            val transport = services.firstOrNull { (tag(it, "serviceType") ?: "").startsWith("urn:schemas-upnp-org:service:AVTransport:") } ?: return null
            val control = base.resolve(tag(transport, "controlURL") ?: "")
            if (control.host != where.host || control.scheme != "http") return null
            // Volume lives in RenderingControl, a second service of the same device (same host rule).
            val renderingService = services.firstOrNull { (tag(it, "serviceType") ?: "").startsWith("urn:schemas-upnp-org:service:RenderingControl:") }
            val rendering = renderingService?.let { base.resolve(tag(it, "controlURL") ?: "") }?.takeIf { it.host == where.host && it.scheme == "http" }
            Renderer(
                tag(xml, "UDN") ?: location,
                tag(xml, "friendlyName") ?: where.host,
                listOfNotNull(tag(xml, "manufacturer"), tag(xml, "modelName")).joinToString(" "),
                where.host, control.toString(), tag(transport, "serviceType") ?: AV_TRANSPORT,
                rendering?.toString(), renderingService?.let { tag(it, "serviceType") } ?: RENDERING_CONTROL,
            )
        }.getOrNull()
    }

    /** 0.0 to 1.0 as UPnP's whole percent, kept inside 0 to 100. */
    fun volumeToPercent(level: Double): Int = Math.round(level.coerceIn(0.0, 1.0) * 100).toInt()
    fun percentToVolume(percent: Double): Double = (percent / 100.0).coerceIn(0.0, 1.0)

    /** "0:03:21" for 201.4 seconds (the form UPnP uses for times). */
    fun upnpTime(seconds: Double): String {
        val s = maxOf(0.0, seconds).toLong()
        return "${s / 3600}:${"%02d".format((s % 3600) / 60)}:${"%02d".format(s % 60)}"
    }

    /** Seconds in "0:03:21" or "00:03:21.500"; 0 for "NOT_IMPLEMENTED" and the like. */
    fun parseUpnpTime(text: String?): Double {
        val m = Regex("^(\\d+):(\\d{1,2}):(\\d{1,2})(?:\\.(\\d+))?").find((text ?: "").trim()) ?: return 0.0
        return m.groupValues[1].toDouble() * 3600 + m.groupValues[2].toDouble() * 60 + m.groupValues[3].toDouble() + (m.groupValues[4].takeIf { it.isNotEmpty() }?.let { "0.$it".toDouble() } ?: 0.0)
    }

    /** DIDL-Lite describing one song, so the TV can show its title, artist, album and cover. */
    fun didl(song: CastSong): String {
        val duration = if (song.seconds > 0) " duration=\"${upnpTime(song.seconds)}.000\"" else ""
        val pn = if (song.mime == "audio/mpeg") "DLNA.ORG_PN=MP3;" else ""
        return "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">" +
            "<item id=\"0\" parentID=\"-1\" restricted=\"1\">" +
            "<dc:title>${escapeXml(song.title)}</dc:title>" +
            (song.artist?.let { "<dc:creator>${escapeXml(it)}</dc:creator><upnp:artist>${escapeXml(it)}</upnp:artist>" } ?: "") +
            (song.album?.let { "<upnp:album>${escapeXml(it)}</upnp:album>" } ?: "") +
            (song.cover?.let { "<upnp:albumArtURI>${escapeXml(it)}</upnp:albumArtURI>" } ?: "") +
            "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
            "<res protocolInfo=\"http-get:*:${escapeXml(song.mime)}:${pn}DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000\"$duration>${escapeXml(song.url)}</res>" +
            "</item></DIDL-Lite>"
    }

    fun soapBody(service: String, action: String, args: List<Pair<String, String>>): String {
        val inner = args.joinToString("") { (k, v) -> "<$k>${escapeXml(v)}</$k>" }
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">" +
            "<s:Body><u:$action xmlns:u=\"$service\">$inner</u:$action></s:Body></s:Envelope>"
    }

    // ---------- Over the network ----------

    /** A small HTTP request with time and size limits: (status, body). Home network addresses only. */
    fun http(address: String, method: String = "GET", headers: Map<String, String> = emptyMap(), body: String? = null, timeoutMs: Int = 4000): Pair<Int, String> {
        val url = URL(address)
        if (url.protocol != "http" || !ShareServer.isHomeNetworkAddress(url.host)) throw IOException("Only devices on the home network are spoken to.")
        val c = url.openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            for ((k, v) in headers) c.setRequestProperty(k, v)
            if (body != null) {
                c.doOutput = true
                val bytes = body.toByteArray(Charsets.UTF_8)
                c.setFixedLengthStreamingMode(bytes.size)
                c.outputStream.use { it.write(bytes) }
            }
            val status = c.responseCode
            val stream = if (status in 200..399) c.inputStream else c.errorStream
            val text = stream?.use { s ->
                val out = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val n = s.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    if (out.size() > MAX_REPLY) throw IOException("The device's answer was too long.")
                }
                out.toString("UTF-8")
            } ?: ""
            return status to text
        } finally {
            c.disconnect()
        }
    }

    /** Searches for about `seconds` and returns the renderers found. */
    fun search(context: Context, seconds: Int = 3): List<Renderer> {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = wifi?.createMulticastLock("mediaverse-dlna")?.apply { setReferenceCounted(false); acquire() }
        val locations = HashMap<String, String>() // location -> sender address
        try {
            DatagramSocket().use { socket ->
                socket.soTimeout = 300
                val text = searchMessage(maxOf(1, minOf(3, seconds - 1))).toByteArray()
                val group = InetAddress.getByName(SSDP_ADDRESS)
                fun send() = runCatching { socket.send(DatagramPacket(text, text.size, group, SSDP_PORT)) }
                send()
                val end = System.currentTimeMillis() + seconds * 1000L
                var resent = false
                val buffer = ByteArray(4096)
                while (System.currentTimeMillis() < end) {
                    if (!resent && System.currentTimeMillis() > end - seconds * 1000L + 400) { send(); resent = true }
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        socket.receive(packet)
                        val from = packet.address.hostAddress ?: continue
                        val headers = parseSsdpReply(String(packet.data, 0, packet.length)) ?: continue
                        val location = headers["location"] ?: continue
                        if (!ShareServer.isHomeNetworkAddress(from)) continue
                        // Only descriptions served by the device that answered.
                        if (runCatching { URL(location).host }.getOrNull() == from) locations[location] = from
                    } catch (_: SocketTimeoutException) {
                    }
                }
            }
        } catch (error: Exception) {
            Log.i(CastConnection.TAG, "dlna search: ${error.message}")
        } finally {
            runCatching { lock?.release() }
        }
        Log.i(CastConnection.TAG, "dlna search: ${locations.size} answers ${locations.keys}")
        return locations.keys.mapNotNull { location ->
            runCatching {
                val (status, body) = http(location, timeoutMs = 3000)
                (if (status == 200) parseDescription(body, location) else null).also { if (it == null) Log.i(CastConnection.TAG, "dlna: $location is not a player (status $status)") }
            }.onFailure { Log.i(CastConnection.TAG, "dlna: $location: ${it.message}") }.getOrNull()
        }
    }
}

/** One DLNA renderer playing songs the phone sends it (the AVTransport actions of dlna.js). */
class DlnaTarget(private val control: String, private val service: String, private val rendering: String? = null, private val renderingService: String = Dlna.RENDERING_CONTROL) : CastTarget {
    private fun act(action: String, vararg args: Pair<String, String>, address: String = control, serviceType: String = service): String {
        val (status, body) = Dlna.http(
            address, "POST",
            mapOf("Content-Type" to "text/xml; charset=\"utf-8\"", "SOAPACTION" to "\"$serviceType#$action\""),
            Dlna.soapBody(serviceType, action, listOf("InstanceID" to "0") + args.toList()),
        )
        if (status != 200) {
            val why = Dlna.tag(body, "errorDescription") ?: Dlna.tag(body, "faultstring") ?: "error $status"
            throw IOException("The TV refused $action: $why")
        }
        return body
    }

    override fun load(song: CastSong, startSeconds: Double) {
        runCatching { act("Stop") } // some renderers refuse a new song while one plays
        act("SetAVTransportURI", "CurrentURI" to song.url, "CurrentURIMetaData" to Dlna.didl(song))
        act("Play", "Speed" to "1")
        if (startSeconds > 1) {
            Thread.sleep(1500) // seeking works once the TV has started the song
            runCatching { seek(startSeconds) }
        }
    }

    override fun play() { act("Play", "Speed" to "1") }
    override fun pause() { act("Pause") }
    override fun seek(seconds: Double) { act("Seek", "Unit" to "REL_TIME", "Target" to Dlna.upnpTime(seconds)) }
    override fun stop() { act("Stop") }
    override fun close() {}

    private var polls = 0
    private var lastVolume = -1.0

    /** Volume 0.0 to 1.0 through RenderingControl (0 to 100 on the wire); also takes the device off mute. */
    override fun setVolume(level: Double) {
        val address = rendering ?: return
        val percent = Dlna.volumeToPercent(level)
        act("SetVolume", "Channel" to "Master", "DesiredVolume" to percent.toString(), address = address, serviceType = renderingService)
        runCatching { act("SetMute", "Channel" to "Master", "DesiredMute" to "0", address = address, serviceType = renderingService) }
        lastVolume = percent / 100.0
    }

    override fun status(): CastStatus {
        // Volume is asked about every fourth poll only: it is one more request to a small device.
        val volumeAddress = rendering
        if (volumeAddress != null && polls++ % 4 == 0) {
            runCatching {
                val muted = Dlna.tag(act("GetMute", "Channel" to "Master", address = volumeAddress, serviceType = renderingService), "CurrentMute") == "1"
                val v = Dlna.tag(act("GetVolume", "Channel" to "Master", address = volumeAddress, serviceType = renderingService), "CurrentVolume")?.toDoubleOrNull()
                if (v != null) lastVolume = if (muted) 0.0 else Dlna.percentToVolume(v)
            }
        }
        val transport = act("GetTransportInfo")
        val position = act("GetPositionInfo")
        val state = Dlna.tag(transport, "CurrentTransportState") ?: "UNKNOWN"
        val pos = Dlna.parseUpnpTime(Dlna.tag(position, "RelTime"))
        val dur = Dlna.parseUpnpTime(Dlna.tag(position, "TrackDuration"))
        // A renderer says STOPPED (or NO_MEDIA_PRESENT) when the song has finished.
        val stopped = state == "STOPPED" || state == "NO_MEDIA_PRESENT"
        return CastStatus(if (stopped) "STOPPED" else state, pos, dur, stopped, Dlna.tag(position, "TrackURI").orEmpty(), lastVolume)
    }
}
