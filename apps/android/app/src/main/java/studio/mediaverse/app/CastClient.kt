package studio.mediaverse.app

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.InetSocketAddress
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/** What one Cast device is asked to play: a link the device can open, and what to show. */
data class CastSong(val url: String, val mime: String, val title: String, val artist: String?, val album: String?, val cover: String?, val seconds: Double, val lyrics: JSONObject? = null)

/** The device's player state, in the same words as DLNA's. */
data class CastStatus(val state: String, val position: Double, val duration: Double, val finished: Boolean, val contentId: String, val volume: Double = -1.0, val itemId: Int = 0)

/**
 * One connection to a Cast device (Chromecast, Google TV, Cast speaker): TLS to port 8009, messages as in [CastWire],
 * JSON on the connection, heartbeat, receiver and media namespaces. A port of CastConnection in the computer's
 * web/app/electron/googlecast.js. Devices present certificates signed by Google's device CA, not a public one, so
 * the certificate is not checked: the link is encrypted, and only home network addresses are used.
 */
class CastConnection(private val host: String, private val port: Int) {
    private var socket: SSLSocket? = null
    private var nextId = 1
    private val waiting = ConcurrentHashMap<Int, CompletableFuture<JSONObject>>()
    val connectedTo: MutableSet<String> = ConcurrentHashMap.newKeySet()
    val listeners = CopyOnWriteArrayList<(String, JSONObject) -> Unit>()
    @Volatile var closed = false
        private set

    fun open(): CastConnection {
        if (!ShareServer.isHomeNetworkAddress(host)) throw IOException("Only devices on the home network are spoken to.")
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf<TrustManager>(trustAll), SecureRandom())
        val s = context.socketFactory.createSocket() as SSLSocket
        s.connect(InetSocketAddress(host, port), 8000)
        s.startHandshake()
        socket = s
        sendTo("receiver-0", NS_CONNECTION, JSONObject().put("type", "CONNECT"))
        connectedTo += "receiver-0"
        Thread({ read(s) }, "cast-read").apply { isDaemon = true }.start()
        Thread({
            while (!closed) {
                try { Thread.sleep(5000); sendTo("receiver-0", NS_HEARTBEAT, JSONObject().put("type", "PING")) } catch (_: Exception) { close() }
            }
        }, "cast-heartbeat").apply { isDaemon = true }.start()
        return this
    }

    private fun read(s: SSLSocket) {
        val framer = CastWire.Framer { receive(it) }
        val buffer = ByteArray(8192)
        try {
            val input = s.getInputStream()
            while (!closed) {
                val n = input.read(buffer)
                if (n < 0) break
                framer.feed(buffer, n)
            }
        } catch (error: Exception) {
            if (!closed) Log.i(TAG, "cast read: ${error.message}")
        }
        close()
    }

    @Synchronized
    fun sendTo(destination: String, namespace: String, data: JSONObject) {
        val s = socket
        if (s == null || closed) throw IOException("Not connected to the device.")
        val out = s.getOutputStream()
        out.write(CastWire.frame(CastWire.encode(destination, namespace, data.toString())))
        out.flush()
    }

    /** Sends a request and waits for the answer that carries the same requestId. */
    fun request(destination: String, namespace: String, data: JSONObject, timeoutMs: Long = 10_000): JSONObject {
        val id = synchronized(this) { nextId++ }
        val future = CompletableFuture<JSONObject>()
        waiting[id] = future
        try {
            sendTo(destination, namespace, JSONObject(data.toString()).put("requestId", id))
            return future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (error: TimeoutException) {
            throw IOException("The device did not answer in time.")
        } catch (error: java.util.concurrent.ExecutionException) {
            throw (error.cause as? IOException) ?: IOException(error.cause?.message ?: "The device refused.")
        } finally {
            waiting.remove(id)
        }
    }

    private fun receive(bytes: ByteArray) {
        val message = runCatching { CastWire.decode(bytes) }.getOrNull() ?: return
        if (message.binary) return
        val data = runCatching { JSONObject(message.text ?: return) }.getOrNull() ?: return
        if (message.namespace == NS_HEARTBEAT && data.optString("type") == "PING") {
            runCatching { sendTo(message.source, NS_HEARTBEAT, JSONObject().put("type", "PONG")) }
            return
        }
        if (message.namespace == NS_CONNECTION && data.optString("type") == "CLOSE") connectedTo -= message.source
        val requestId = data.optInt("requestId", 0)
        val waiter = if (requestId != 0) waiting.remove(requestId) else null
        if (waiter != null) {
            val type = data.optString("type")
            if (Regex("^(LAUNCH_ERROR|LOAD_FAILED|LOAD_CANCELLED|INVALID_REQUEST|INVALID_PLAYER_STATE)$").matches(type)) {
                waiter.completeExceptionally(IOException("The device refused: ${data.optString("reason").ifEmpty { type }}"))
            } else waiter.complete(data)
        }
        for (listener in listeners) listener(message.namespace, data)
    }

    fun close() {
        if (closed) return
        closed = true
        for (waiter in waiting.values) waiter.completeExceptionally(IOException("The connection to the device closed."))
        waiting.clear()
        runCatching { socket?.close() }
    }

    companion object {
        const val TAG = "MediaVerseCast"
        const val NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection"
        const val NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat"
        const val NS_RECEIVER = "urn:x-cast:com.google.cast.receiver"
        const val NS_MEDIA = "urn:x-cast:com.google.cast.media"
    }
}

/**
 * One Cast device with the music player running on it (a port of createGoogleCast in googlecast.js). The MediaVerse
 * receiver is tried first; a device that cannot open it gets Google's Default Media Receiver, remembered for it.
 */
class CastSession(val host: String, val port: Int) : CastTarget {
    private var connection: CastConnection? = null
    private var transportId: String? = null
    private var mediaSessionId: Int? = null
    private var appId: String = MEDIAVERSE_RECEIVER
    private var polls = 0
    @Volatile private var deviceVolume = -1.0

    /** The device volume from the receiver status (not the media stream volume, which TVs leave at 1). */
    private fun readDeviceVolume(c: CastConnection): Double = runCatching {
        val v = c.request("receiver-0", CastConnection.NS_RECEIVER, JSONObject().put("type", "GET_STATUS")).optJSONObject("status")?.optJSONObject("volume") ?: return -1.0
        Log.i(CastConnection.TAG, "device volume: $v")
        if (v.optBoolean("muted", false)) 0.0 else v.optDouble("level", -1.0)
    }.getOrDefault(-1.0)

    @Synchronized
    private fun connected(): CastConnection {
        val existing = connection
        if (existing != null && !existing.closed) return existing
        val fresh = CastConnection(host, port).open()
        connection = fresh
        transportId = null
        mediaSessionId = null
        fresh.listeners += { namespace, data ->
            if (namespace == CastConnection.NS_MEDIA && data.optString("type") == "MEDIA_STATUS") {
                data.optJSONArray("status")?.optJSONObject(0)?.optInt("mediaSessionId", 0)?.takeIf { it != 0 }?.let { mediaSessionId = it }
            }
        }
        return fresh
    }

    private fun application(reply: JSONObject, id: String): JSONObject? {
        val apps: JSONArray = reply.optJSONObject("status")?.optJSONArray("applications") ?: return null
        return (0 until apps.length()).map { apps.getJSONObject(it) }.firstOrNull { it.optString("appId") == id }
    }

    /** Makes sure the receiver app runs and returns its transport id (the address of its media channel). */
    @Synchronized
    private fun launched(): String {
        val c = connected()
        var app = application(c.request("receiver-0", CastConnection.NS_RECEIVER, JSONObject().put("type", "GET_STATUS")), appId)
        if (app == null) {
            try {
                app = application(c.request("receiver-0", CastConnection.NS_RECEIVER, JSONObject().put("type", "LAUNCH").put("appId", appId), 20_000), appId)
            } catch (error: IOException) {
                if (appId == DEFAULT_RECEIVER) throw error
                Log.i(CastConnection.TAG, "cannot open the MediaVerse player (${error.message}); using Google's")
                appId = DEFAULT_RECEIVER
                app = application(c.request("receiver-0", CastConnection.NS_RECEIVER, JSONObject().put("type", "LAUNCH").put("appId", appId), 20_000), appId)
            }
        }
        val transport = app?.optString("transportId").orEmpty()
        if (transport.isEmpty()) throw IOException("The music player did not start on the device.")
        if (transport !in c.connectedTo) {
            c.sendTo(transport, CastConnection.NS_CONNECTION, JSONObject().put("type", "CONNECT"))
            c.connectedTo += transport
        }
        transportId = transport
        return transport
    }

    /** What a song looks like to the device. */
    private fun mediaJson(song: CastSong): JSONObject {
        val metadata = JSONObject().put("metadataType", 3).put("title", song.title)
        song.artist?.let { metadata.put("artist", it) }
        song.album?.let { metadata.put("albumName", it) }
        song.cover?.let { metadata.put("images", JSONArray().put(JSONObject().put("url", it))) }
        val media = JSONObject().put("contentId", song.url).put("contentType", song.mime).put("streamType", "BUFFERED").put("metadata", metadata)
        if (song.seconds > 0) media.put("duration", song.seconds)
        // The MediaVerse receiver shows the lyrics (as when the desktop program casts); Google's ignores them.
        if (appId == MEDIAVERSE_RECEIVER) song.lyrics?.let { media.put("customData", JSONObject().put("lyrics", it)) }
        return media
    }

    /** A queue entry: the device fetches the next song ahead of time (`preloadTime` seconds before the end), so it follows without a gap. */
    private fun queueItem(song: CastSong): JSONObject = JSONObject().put("media", mediaJson(song)).put("autoplay", true).put("preloadTime", 20).put("startTime", 0)

    // Songs are loaded as a one-song queue so that the next one can be added behind it (gapless). A device that refuses a
    // queue gets plain loads, as before (and the next song is loaded when the end is seen).
    private var queueSupported = true
    @Volatile private var queueActive = false

    override val canPreload: Boolean get() = queueSupported && queueActive

    override fun load(song: CastSong, startSeconds: Double) {
        val c = connected()
        val transport = launched()
        queueActive = false
        if (queueSupported) {
            try {
                val reply = c.request(
                    transport, CastConnection.NS_MEDIA,
                    JSONObject().put("type", "QUEUE_LOAD").put("items", JSONArray().put(queueItem(song))).put("startIndex", 0).put("repeatMode", "REPEAT_OFF")
                        .put("currentTime", maxOf(0.0, startSeconds)),
                    30_000,
                )
                reply.optJSONArray("status")?.optJSONObject(0)?.optInt("mediaSessionId", 0)?.takeIf { it != 0 }?.let { mediaSessionId = it }
                queueActive = true
                return
            } catch (error: IOException) {
                // Only a refusal means "no queues here"; a lost connection or a slow device is the caller's to handle.
                if (error.message?.startsWith("The device refused") != true) throw error
                Log.i(CastConnection.TAG, "$host does not take a queue (${error.message}); loading one song at a time")
                queueSupported = false
            }
        }
        val reply = c.request(
            transport, CastConnection.NS_MEDIA,
            JSONObject().put("type", "LOAD").put("autoplay", true).put("currentTime", maxOf(0.0, startSeconds)).put("media", mediaJson(song)), 30_000,
        )
        reply.optJSONArray("status")?.optJSONObject(0)?.optInt("mediaSessionId", 0)?.takeIf { it != 0 }?.let { mediaSessionId = it }
    }

    override fun preloadNext(song: CastSong) {
        if (!canPreload) return
        // Right after a load the device may not have announced the new media session yet: look again a few times.
        for (attempt in 0..4) {
            try {
                media(JSONObject().put("type", "QUEUE_INSERT").put("items", JSONArray().put(queueItem(song))))
                return
            } catch (error: IOException) {
                if (attempt == 4 || error.message?.contains("INVALID_MEDIA_SESSION_ID") != true) throw error
                Thread.sleep(600)
            }
        }
    }

    private fun media(command: JSONObject): JSONObject {
        val c = connected()
        val transport = transportId ?: launched()
        val id = mediaSessionId ?: throw IOException("Nothing is playing on the device.")
        return c.request(transport, CastConnection.NS_MEDIA, JSONObject(command.toString()).put("mediaSessionId", id))
    }

    override fun play() { media(JSONObject().put("type", "PLAY")) }
    override fun pause() { media(JSONObject().put("type", "PAUSE")) }
    override fun seek(seconds: Double) { media(JSONObject().put("type", "SEEK").put("currentTime", maxOf(0.0, seconds))) }

    override fun status(): CastStatus {
        val c = connected()
        val transport = transportId ?: launched()
        val reply = c.request(transport, CastConnection.NS_MEDIA, JSONObject().put("type", "GET_STATUS"))
        val now = reply.optJSONArray("status")?.optJSONObject(0)
            ?: return CastStatus("STOPPED", 0.0, 0.0, false, "")
        val state = when (now.optString("playerState")) {
            "PLAYING" -> "PLAYING"; "PAUSED" -> "PAUSED_PLAYBACK"; "BUFFERING" -> "TRANSITIONING"; else -> "STOPPED"
        }
        val media = now.optJSONObject("media")
        if (polls++ % 4 == 0) deviceVolume = readDeviceVolume(c)
        val volume = if (deviceVolume >= 0) deviceVolume else -1.0
        return CastStatus(state, now.optDouble("currentTime", 0.0), media?.optDouble("duration", 0.0) ?: 0.0, now.optString("idleReason") == "FINISHED", media?.optString("contentId").orEmpty(), volume, now.optInt("currentItemId", 0))
    }

    /** The device's own volume (0 to 1), also taking it off mute: a muted receiver plays silently, which looks like "no sound". */
    override fun setVolume(level: Double) {
        val c = connected()
        launched()
        val reply = c.request("receiver-0", CastConnection.NS_RECEIVER, JSONObject().put("type", "SET_VOLUME").put("volume", JSONObject().put("level", level.coerceIn(0.0, 1.0)).put("muted", false)))
        Log.i(CastConnection.TAG, "set volume ${level.coerceIn(0.0, 1.0)} -> ${reply.optJSONObject("status")?.optJSONObject("volume")}")
    }

    /** Stops the song and closes the player, so the TV goes back to what it showed before. Never starts a player. */
    override fun stop() {
        val c = runCatching { connected() }.getOrNull() ?: return
        val transport = transportId
        val media = mediaSessionId
        if (transport != null && media != null) runCatching { c.request(transport, CastConnection.NS_MEDIA, JSONObject().put("type", "STOP").put("mediaSessionId", media)) }
        runCatching {
            val reply = c.request("receiver-0", CastConnection.NS_RECEIVER, JSONObject().put("type", "GET_STATUS"))
            for (id in listOf(MEDIAVERSE_RECEIVER, DEFAULT_RECEIVER)) {
                val sessionId = application(reply, id)?.optString("sessionId").orEmpty()
                if (sessionId.isNotEmpty()) c.request("receiver-0", CastConnection.NS_RECEIVER, JSONObject().put("type", "STOP").put("sessionId", sessionId))
            }
        }
        transportId = null
        mediaSessionId = null
    }
    override fun close() { connection?.close() }

    companion object {
        /** Google's Default Media Receiver: works on every Cast device without registration. */
        const val DEFAULT_RECEIVER = "CC1AD845"
        /** The MediaVerse Studio receiver (registered 2026-11-06). */
        const val MEDIAVERSE_RECEIVER = "0E81A85C"
    }
}
