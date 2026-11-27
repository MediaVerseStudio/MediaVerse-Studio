package studio.mediaverse.app

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL

/**
 * Lets the page talk to servers on the home network (a Jellyfin server, later the computer's MediaVerse Studio). The
 * page is served from an https address, so the browser engine would refuse plain-http requests; the app makes them
 * instead. Only addresses on the home network are allowed (private ranges, this phone, or a short local name), so the
 * page can never be used to reach the internet through this door.
 */
object HomeHttp {
    /** Room for the song list of a very large library (about 300 bytes a song, D214). */
    private const val MAX_BODY = 48 * 1024 * 1024

    /** Whether an address belongs to the home network or this phone. */
    fun isHomeAddress(address: InetAddress): Boolean =
        address.isLoopbackAddress || address.isSiteLocalAddress || address.isLinkLocalAddress ||
            // IPv6 unique local addresses (fc00::/7) are the home-network range for IPv6.
            (address.address.size == 16 && (address.address[0].toInt() and 0xFE) == 0xFC)

    /** Runs the page's request: `{id, method, url, headers, body, timeout}`; answers `{type: "http", id, status, body}`. */
    fun handle(message: JSONObject): JSONObject {
        val id = message.optString("id")
        fun reply(status: Int, body: String) = JSONObject().put("type", "http").put("id", id).put("status", status).put("body", body)
        return try {
            val url = URL(message.optString("url"))
            if (url.protocol != "http" && url.protocol != "https") return reply(-2, "Only http and https addresses are used.")
            if (InetAddress.getAllByName(url.host).none { isHomeAddress(it) }) return reply(-2, "Only addresses on the home network can be reached.")
            val connection = url.openConnection() as HttpURLConnection
            try {
                val timeout = message.optInt("timeout", 15_000).coerceIn(500, 60_000)
                connection.connectTimeout = timeout
                connection.readTimeout = timeout
                connection.requestMethod = message.optString("method", "GET").uppercase().takeIf { it in setOf("GET", "POST", "DELETE", "PUT") } ?: "GET"
                message.optJSONObject("headers")?.let { h -> h.keys().forEach { connection.setRequestProperty(it, h.optString(it)) } }
                val body = message.optString("body", "")
                if (body.isNotEmpty()) {
                    connection.doOutput = true
                    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                val text = stream?.use { s -> s.readNBytes(MAX_BODY).toString(Charsets.UTF_8) } ?: ""
                reply(status, text)
            } finally {
                connection.disconnect()
            }
        } catch (e: Exception) {
            reply(-1, e.message ?: "The server did not answer.")
        }
    }
}
