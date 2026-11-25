package studio.mediaverse.app

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.Executors

/**
 * The phone's library for the TV app, over the home network: the same API, port and pairing as MediaVerse Studio
 * on the computer (web/app/electron/library-share.js, web/app/tv/api.ts), so the TV app finds the phone when it
 * searches for computers and plays its music. Off until switched on; home network addresses only; a TV pairs once
 * with a 6-digit code shown on the phone and then sends its key (kept here only as a hash) with every request.
 * Read only, except favorites.
 */
object ShareServer {
    const val PORT = 47700
    private const val API_VERSION = 2
    private const val MAX_WRONG_CODES = 5
    private const val LOCKOUT_MS = 10 * 60_000L
    private const val PAIRING_MS = 5 * 60_000L
/** How long Settings leaves pairing open after "Pair a TV or speaker". A TV cannot start pairing on its own (D151, like the computer). */
private const val ARM_MS = 5 * 60_000L
    private const val MAX_DEVICES = 20
    /** A media ticket (song and cover addresses only) lasts a listening session; it is not the device key. */
    private const val TICKET_MS = 12 * 60 * 60_000L
    private const val MAX_TICKETS = 40
    private const val PREFS = "share"

    data class Device(val id: String, val name: String, val keyHash: String, val paired: String)
    data class Pairing(val code: String, val name: String, val address: String, val expires: Long)

    private val random = SecureRandom()
    private class Ticket(val deviceId: String, var expires: Long)
    private val tickets = LinkedHashMap<String, Ticket>()
    /** The ticket to send back on this connection's reply (set once the TV is known; each connection has its own thread). */
    private val replyTicket = ThreadLocal<String?>()
    private var server: ServerSocket? = null
    private var pool = Executors.newFixedThreadPool(8)
    private lateinit var app: Context
    private val wrongCodes = HashMap<String, Pair<Int, Long>>()
    /** When pairing stops being open (set by the person pressing Pair a TV or speaker); 0 when it is closed. */
    @Volatile var armedUntil = 0L
        private set
    @Volatile var pairing: Pairing? = null
        private set
    @Volatile var problem: String? = null
        private set

    /** Told when something the Settings page shows changes (a TV asks to pair, pairs, is removed). */
    @Volatile var onChange: () -> Unit = {}

    val running: Boolean get() = server?.isClosed == false

    fun pairingArmed(): Boolean = armedUntil > System.currentTimeMillis()

    /** The person pressed Pair a TV or speaker: for the next few minutes one device may ask to pair. */
    fun armPairing() {
        armedUntil = System.currentTimeMillis() + ARM_MS
        onChange()
    }

    fun enabled(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)

    fun devices(context: Context): List<Device> {
        val text = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("devices", "[]") ?: "[]"
        return runCatching {
            val list = JSONArray(text)
            (0 until list.length()).map { list.getJSONObject(it) }.map { Device(it.getString("id"), it.getString("name"), it.getString("key_hash"), it.optString("paired")) }
        }.getOrDefault(emptyList())
    }

    private fun saveDevices(context: Context, devices: List<Device>) {
        val list = JSONArray()
        devices.takeLast(MAX_DEVICES).forEach { list.put(JSONObject().put("id", it.id).put("name", it.name).put("key_hash", it.keyHash).put("paired", it.paired)) }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("devices", list.toString()).apply()
    }

    fun removeDevice(context: Context, id: String) {
        saveDevices(context, devices(context).filter { it.id != id })
        onChange()
    }

    @Synchronized
    fun setEnabled(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", on).apply()
        if (on) start(context) else stop()
        onChange()
    }

    /** Starts the server if sharing is on (when the app or the player starts). */
    @Synchronized
    fun start(context: Context, forCasting: Boolean = false) {
        app = context.applicationContext
        if (running || (!enabled(app) && !forCasting)) return
        problem = null
        try {
            val socket = ServerSocket()
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(PORT))
            server = socket
            if (pool.isShutdown) pool = Executors.newFixedThreadPool(8)
            Thread({ acceptLoop(socket) }, "share-server").apply { isDaemon = true }.start()
        } catch (error: Exception) {
            problem = "Port $PORT could not be opened: ${error.message}"
        }
    }

    // ---------- Casting: links a TV or speaker can open without pairing ----------
    // A song or cover link for a cast device carries a random token made when the phone first casts in this run of the
    // app. It opens only audio and covers, only from the home network, and nothing else on the server. With sharing
    // switched off the server answers nothing but these links.

    @Volatile private var castToken: String? = null

    /** Starts the server for casting even when sharing with TVs is off. */
    fun startForCasting(context: Context) = start(context, forCasting = true)

    /** `kind` is "audio" or "cover"; null when the phone has no home network address. */
    fun castUrl(kind: String, id: Long, extra: String = ""): String? {
        val ip = addresses().firstOrNull() ?: return null
        val token = castToken ?: ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it) }.also { castToken = it }
        return "http://$ip:$PORT/api/$kind/$id?cast=$token$extra"
    }

    private fun castTokenOk(given: String?): Boolean {
        val token = castToken
        return token != null && given != null && given.length == token.length && sameBytes(given, token)
    }

    @Synchronized
    fun stop() {
        pairing = null
        runCatching { server?.close() }
        server = null
    }

    /** The phone's IPv4 addresses on the home network, for the Settings page. */
    fun addresses(): List<String> = runCatching {
        NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }.filterIsInstance<Inet4Address>().map { it.hostAddress ?: "" }
            .filter { isHomeNetworkAddress(it) && !it.startsWith("169.254.") }
    }.getOrDefault(emptyList())

    /** The name the TV shows: the phone's model ("Pixel 11 Pro"). */
    fun deviceName(): String = Build.MODEL.ifBlank { "Android phone" }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try { socket.accept() } catch (_: Exception) { break }
            pool.execute { runCatching { client.use { handle(it) } } }
        }
    }

    // ---------- Rules shared with the computer's server ----------

    /** Private IPv4, link-local and loopback addresses: only the home network. */
    fun isHomeNetworkAddress(address: String): Boolean {
        var ip = address.lowercase()
        if (ip.startsWith("::ffff:") && ip.contains('.')) ip = ip.removePrefix("::ffff:")
        if (ip.contains('.')) {
            val parts = ip.split('.').map { it.toIntOrNull() ?: return false }
            if (parts.size != 4 || parts.any { it !in 0..255 }) return false
            val (a, b) = parts
            return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        if (ip == "::1") return true
        return Regex("^fe[89ab][0-9a-f]:").containsMatchIn(ip) || Regex("^f[cd][0-9a-f]{2}:").containsMatchIn(ip)
    }

    /** "bytes=0-99" against a size: null to send everything, "invalid" (as null start) when it cannot be met. */
    fun parseRange(header: String?, size: Long): LongRange? {
        if (header.isNullOrBlank() || header.contains(',')) return null
        val match = Regex("^bytes=(\\d*)-(\\d*)$").find(header.trim()) ?: return null
        val (from, to) = match.destructured
        if (from.isEmpty() && to.isEmpty()) return LongRange.EMPTY
        val start: Long
        val end: Long
        if (from.isEmpty()) {
            val suffix = to.toLongOrNull() ?: return LongRange.EMPTY
            if (suffix == 0L) return LongRange.EMPTY
            start = maxOf(0, size - suffix)
            end = size - 1
        } else {
            start = from.toLongOrNull() ?: return LongRange.EMPTY
            end = if (to.isEmpty()) size - 1 else minOf(to.toLongOrNull() ?: return LongRange.EMPTY, size - 1)
        }
        if (start >= size || start > end) return LongRange.EMPTY
        return start..end
    }

    fun keyHash(key: String): String = MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }

    private fun sameBytes(a: String, b: String): Boolean = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())

    private fun cleanName(name: String?): String? = name?.replace(Regex("[\\u0000-\\u001f\\u007f<>]"), "")?.trim()?.take(40)?.ifEmpty { null }

    // ---------- HTTP ----------

    private class Request(val method: String, val path: String, val query: Map<String, String>, val headers: Map<String, String>, val body: String, val address: String)

    private fun readLine(input: InputStream): String? {
        val line = StringBuilder()
        while (true) {
            val c = input.read()
            if (c == -1) return if (line.isEmpty()) null else line.toString()
            if (c == '\n'.code) return line.toString().trimEnd('\r')
            if (line.length > 8192) throw IllegalStateException("line too long")
            line.append(c.toChar())
        }
    }

    private fun handle(socket: Socket) {
        socket.soTimeout = 20_000
        val input = BufferedInputStream(socket.getInputStream())
        val output = socket.getOutputStream()
        val address = (socket.inetAddress as InetAddress).hostAddress ?: ""
        // One request per connection (Connection: close), as simple as can be for a TV on the home network.
        val request = try {
            val first = readLine(input) ?: return
            val parts = first.split(' ')
            if (parts.size < 2) return
            val headers = HashMap<String, String>()
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
                if (headers.size > 50) return
            }
            val length = headers["content-length"]?.toIntOrNull() ?: 0
            if (length > 4096) return send(output, 413, "Too big.")
            val body = ByteArray(length)
            var read = 0
            while (read < length) { val n = input.read(body, read, length - read); if (n < 0) break; read += n }
            val target = parts[1]
            val path = target.substringBefore('?')
            val query = target.substringAfter('?', "").split('&').filter { it.contains('=') }.associate {
                URLDecoder.decode(it.substringBefore('='), "UTF-8") to URLDecoder.decode(it.substringAfter('='), "UTF-8")
            }
            Request(parts[0].uppercase(), path, query, headers, String(body, 0, read), address)
        } catch (_: SocketTimeoutException) {
            return
        }
        respond(request, output)
    }

    private fun send(output: OutputStream, status: Int, body: Any, extra: Map<String, String> = emptyMap(), head: Boolean = false) {
        val json = body !is String
        val bytes = (if (json) body.toString() else body as String).toByteArray()
        val headers = linkedMapOf(
            "Content-Type" to if (json) "application/json; charset=utf-8" else "text/plain; charset=utf-8",
            "Content-Length" to bytes.size.toString(),
            "Cache-Control" to "no-store",
        ) + extra
        writeHead(output, status, headers)
        if (!head) output.write(bytes)
        output.flush()
    }

    private fun writeHead(output: OutputStream, status: Int, headers: Map<String, String>) {
        val text = StringBuilder("HTTP/1.1 $status ${reason(status)}\r\n")
        // The TV app's page has no web origin of its own.
        text.append("Access-Control-Allow-Origin: *\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n")
        replyTicket.get()?.let { text.append("X-MediaVerse-Ticket: $it\r\nAccess-Control-Expose-Headers: X-MediaVerse-Ticket\r\n") }
        for ((k, v) in headers) text.append("$k: $v\r\n")
        text.append("\r\n")
        output.write(text.toString().toByteArray())
    }

    private fun reason(status: Int) = when (status) {
        200 -> "OK"; 204 -> "No Content"; 206 -> "Partial Content"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"
        404 -> "Not Found"; 405 -> "Method Not Allowed"; 409 -> "Conflict"; 410 -> "Gone"; 413 -> "Payload Too Large"; 416 -> "Range Not Satisfiable"
        429 -> "Too Many Requests"; 501 -> "Not Implemented"; else -> "Error"
    }

    private fun error(kind: String, message: String) = JSONObject().put("error", kind).put("message", message)

    private fun lockedOut(address: String): Boolean = synchronized(wrongCodes) {
        val (count, until) = wrongCodes[address] ?: return false
        if (until < System.currentTimeMillis()) { wrongCodes.remove(address); return false }
        count >= MAX_WRONG_CODES
    }

    private fun currentPairing(): Pairing? {
        val now = pairing
        if (now != null && now.expires < System.currentTimeMillis()) { pairing = null; onChange() }
        return pairing
    }

    private fun deviceFor(key: String?): Device? {
        if (key == null || !Regex("^[0-9a-f]{64}$").matches(key)) return null
        val hash = keyHash(key)
        return devices(app).firstOrNull { sameBytes(it.keyHash, hash) }
    }

    /** The key comes in a header (never the address): `Authorization: Bearer <key>` or `X-MediaVerse-Key`. */
    private fun keyFrom(request: Request): String? {
        val auth = request.headers["authorization"]?.trim()
        if (auth != null) Regex("^Bearer\\s+([0-9a-fA-F]{64})$").find(auth)?.let { return it.groupValues[1].lowercase() }
        return request.headers["x-mediaverse-key"]?.trim()?.takeIf { Regex("^[0-9a-f]{64}$").matches(it) }
    }

    /** One live ticket per device, so the one already in a playing song's address is not pushed out of the list. */
    private fun ticketFor(device: Device): String = synchronized(tickets) {
        val now = System.currentTimeMillis()
        tickets.entries.firstOrNull { it.value.deviceId == device.id && it.value.expires > now }?.let {
            it.value.expires = now + TICKET_MS
            return it.key
        }
        val ticket = ByteArray(24).also(random::nextBytes).joinToString("") { "%02x".format(it) }
        tickets[ticket] = Ticket(device.id, now + TICKET_MS)
        while (tickets.size > MAX_TICKETS) tickets.remove(tickets.keys.first())
        ticket
    }

    private fun deviceForTicket(ticket: String?): Device? {
        if (ticket == null || !Regex("^[0-9a-f]{48}$").matches(ticket)) return null
        val id = synchronized(tickets) {
            val entry = tickets[ticket] ?: return null
            if (entry.expires < System.currentTimeMillis()) { tickets.remove(ticket); return null }
            entry.expires = System.currentTimeMillis() + TICKET_MS
            entry.deviceId
        }
        return devices(app).firstOrNull { it.id == id }
    }

    private fun respond(request: Request, output: OutputStream) {
        replyTicket.set(null)
        try {
            answer(request, output)
        } finally {
            replyTicket.remove()
        }
    }

    private fun answer(request: Request, output: OutputStream) {
        val address = request.address
        val head = request.method == "HEAD"
        if (!isHomeNetworkAddress(address)) return send(output, 403, "Only devices on the home network can use this.")
        if (request.method == "OPTIONS") {
            writeHead(output, 204, mapOf("Access-Control-Allow-Methods" to "GET, HEAD, POST", "Access-Control-Allow-Headers" to "Range, Content-Type, Authorization, X-MediaVerse-Key", "Access-Control-Expose-Headers" to "X-MediaVerse-Ticket", "Access-Control-Max-Age" to "600", "Content-Length" to "0"))
            return output.flush()
        }
        // A cast device opens a song or a cover with the phone's cast token instead of a pairing key. With sharing
        // switched off (the server runs only for casting) nothing else is answered, not even pairing.
        val castLink = request.method != "POST" && Regex("^/api/(audio|cover)/[^/]+$").matches(request.path) && castTokenOk(request.query["cast"])
        if (!castLink && !enabled(app)) return send(output, 403, "Sharing with TVs is switched off on the phone.")
        val reporting = request.method == "POST" && request.path == "/api/remote/state"
        val writing = reporting || (request.method == "POST" && Regex("^/api/(flag|favorite)/[^/]+$").matches(request.path))
        if (request.method != "GET" && !head && !writing) return send(output, 405, "Only flags and favorites can be changed.", mapOf("Allow" to "GET, HEAD"))
        if (request.path == "/api/hello") return send(output, 200, JSONObject().put("app", "MediaVerse Studio").put("api", API_VERSION).put("computer", deviceName()), head = head)
        if (lockedOut(address)) return send(output, 429, error("locked", "Too many wrong codes. Try again in 10 minutes."))
        if (request.path == "/api/pair") {
            val current = currentPairing()
            // A TV asks to pair only after someone pressed Pair a TV or speaker on the phone.
            if (!pairingArmed() && !(current != null && current.address == address)) return send(output, 403, error("not_armed", "On the phone, open Settings > TV and press Pair a TV or speaker, then try again."))
            if (current != null && current.address != address) return send(output, 409, error("busy", "Another device is pairing with this phone. Try again in a few minutes."))
            val code = String.format("%06d", random.nextInt(1_000_000))
            pairing = Pairing(code, "${cleanName(request.query["name"]) ?: "TV"} ($address)", address, System.currentTimeMillis() + PAIRING_MS)
            onChange()
            return send(output, 200, JSONObject().put("api", API_VERSION).put("computer", deviceName()).put("expires_in", PAIRING_MS / 1000))
        }
        if (request.path == "/api/pair/confirm") {
            val current = currentPairing()
            if (current == null || current.address != address) return send(output, 410, error("no_pairing", "The pairing code has expired. Start again."))
            val given = (request.query["code"] ?: "").replace(Regex("\\s"), "")
            if (given.length != current.code.length || !sameBytes(given, current.code)) {
                synchronized(wrongCodes) {
                    val (count, _) = wrongCodes[address] ?: (0 to 0L)
                    wrongCodes[address] = (count + 1) to (System.currentTimeMillis() + LOCKOUT_MS)
                }
                if (lockedOut(address)) { pairing = null; onChange() }
                return send(output, 401, error("wrong_code", "That is not the code shown on the phone."))
            }
            synchronized(wrongCodes) { wrongCodes.remove(address) }
            val bytes = ByteArray(32).also(random::nextBytes)
            val key = bytes.joinToString("") { "%02x".format(it) }
            saveDevices(app, devices(app) + Device(UUID.randomUUID().toString(), current.name, keyHash(key), java.time.Instant.now().toString()))
            pairing = null
            armedUntil = 0L // one press pairs one device
            onChange()
            return send(output, 200, JSONObject().put("api", API_VERSION).put("key", key).put("computer", deviceName()))
        }
        val mediaPath = request.method != "POST" && Regex("^/api/(audio|cover)/[^/]+$").matches(request.path)
        val device = deviceFor(keyFrom(request)) ?: if (mediaPath) deviceForTicket(request.query["ticket"]) else null
        if (!castLink) {
            if (device == null) return send(output, 401, error("not_paired", "This TV is not paired with the phone (or was removed in the phone's Settings). Pair it again."))
        }
        if (device != null) {
            replyTicket.set(ticketFor(device))
            if (request.path == "/api/remote" && request.method == "GET") return remotePoll(device, request.query["after"]?.toLongOrNull() ?: -1, output)
            if (reporting) return remoteState(device, request.body, output)
        }

        val library = Library.get(app)
        when {
            request.path == "/api/library" -> {
                val tracks = library.toJson()
                // The computer's names for the same fields: the TV reads `year` and does not need the length.
                return send(output, 200, JSONObject().put("api", API_VERSION).put("tracks", tracks), head = head)
            }
            request.path == "/api/marks" -> return send(output, 200, marks(), head = head)
            writing -> {
                val kind = request.path.split('/')[2]
                val id = URLDecoder.decode(request.path.substringAfterLast('/'), "UTF-8")
                if (library.byId[id.toLongOrNull() ?: -1] == null) return send(output, 404, "No such track.")
                if (kind != "favorite") return send(output, 501, "Flags are not available on the phone.")
                val body = runCatching { JSONObject(request.body.ifBlank { "{}" }) }.getOrNull() ?: return send(output, 400, "The request was not understood.")
                Favorites.set(app, id, body.optBoolean("favorite", true))
                onChange()
                return send(output, 200, marks())
            }
        }
        val match = Regex("^/api/(audio|cover|lyrics)/([^/]+)$").find(request.path) ?: return send(output, 404, "Not found.")
        val (kind, rawId) = match.destructured
        val track = library.byId[URLDecoder.decode(rawId, "UTF-8").toLongOrNull() ?: -1] ?: return send(output, 404, "No such track.")
        when (kind) {
            "audio" -> streamAudio(request, output, track, head)
            "cover" -> {
                val size = request.query["size"]?.toIntOrNull()?.coerceIn(64, 1024) ?: 800
                val file = ArtProvider.cover(app, track.id, ArtProvider.fit(size)) ?: return send(output, 404, "No cover.")
                writeHead(output, 200, mapOf("Content-Type" to "image/jpeg", "Content-Length" to file.length().toString(), "Cache-Control" to "private, max-age=3600"))
                if (!head) file.inputStream().use { it.copyTo(output) }
                output.flush()
            }
            else -> send(output, 200, (Lyrics.read(app, track)?.toJson() ?: Lyrics.none), head = head)
        }
    }

    // ---------- The phone as the TV's remote ----------
    // A paired TV playing from the phone asks for commands (a long poll, GET /api/remote?after=<seq>) and reports
    // what it is playing (POST /api/remote/state). The phone sends "play these songs from here", play/pause, next,
    // previous and seek. Only the TV a command is meant for receives it.

    data class Listener(val id: String, val name: String, val seen: Long, val state: JSONObject?)

    private val remoteLock = Object()
    private var remoteSeq = 0L
    private val commands = ArrayList<Pair<String, JSONObject>>() // target device id -> command (with "seq")
    private val listeners = LinkedHashMap<String, Listener>()

    /** Told when a TV starts or stops listening, or reports what it plays. */
    @Volatile var onRemote: () -> Unit = {}

    /** TVs that asked for commands in the last 30 seconds. */
    fun listening(): List<Listener> = synchronized(remoteLock) {
        val now = System.currentTimeMillis()
        listeners.values.filter { now - it.seen < 30_000 }
    }

    fun sendToTv(deviceId: String, command: JSONObject) {
        synchronized(remoteLock) {
            remoteSeq += 1
            commands += deviceId to JSONObject(command.toString()).put("seq", remoteSeq).put("at", System.currentTimeMillis())
            while (commands.size > 50) commands.removeAt(0)
            remoteLock.notifyAll()
        }
    }

    private fun remotePoll(device: Device, after: Long, output: OutputStream) {
        val fresh: Boolean
        synchronized(remoteLock) {
            fresh = listeners[device.id]?.let { System.currentTimeMillis() - it.seen > 30_000 } ?: true
            listeners[device.id] = Listener(device.id, device.name.substringBefore(" ("), System.currentTimeMillis(), listeners[device.id]?.state)
        }
        if (fresh) onRemote()
        val deadline = System.currentTimeMillis() + 20_000
        val found = ArrayList<JSONObject>()
        var seq: Long
        synchronized(remoteLock) {
            while (true) {
                // A TV that just started listening only learns where the list is; old commands are not replayed.
                val start = if (after < 0) remoteSeq else after
                found.clear()
                commands.filter { (target, command) -> target == device.id && command.getLong("seq") > start && System.currentTimeMillis() - command.getLong("at") < 60_000 }.mapTo(found) { it.second }
                seq = remoteSeq
                val left = deadline - System.currentTimeMillis()
                if (found.isNotEmpty() || after < 0 || left <= 0) break
                remoteLock.wait(left)
            }
            listeners[device.id] = listeners[device.id]!!.copy(seen = System.currentTimeMillis())
        }
        send(output, 200, JSONObject().put("seq", seq).put("commands", JSONArray(found)))
    }

    private fun remoteState(device: Device, body: String, output: OutputStream) {
        val state = runCatching { JSONObject(body) }.getOrNull() ?: return send(output, 400, "The request was not understood.")
        val clean = JSONObject()
            .put("id", state.optString("id").takeIf { it.isNotEmpty() } ?: JSONObject.NULL)
            .put("playing", state.optBoolean("playing"))
            .put("position_ms", state.optLong("position_ms").coerceAtLeast(0))
            .put("duration_ms", state.optLong("duration_ms").coerceAtLeast(0))
            .put("at", System.currentTimeMillis())
        synchronized(remoteLock) {
            listeners[device.id] = Listener(device.id, device.name.substringBefore(" ("), System.currentTimeMillis(), clean)
        }
        onRemote()
        send(output, 204, "")
    }

    private fun marks(): JSONObject = JSONObject().put("favorites", JSONArray(Favorites.all(app).toList())).put("flagged", JSONArray())

    private fun streamAudio(request: Request, output: OutputStream, track: Track, head: Boolean) {
        val resolver = app.contentResolver
        val size = runCatching { resolver.openFileDescriptor(track.uri, "r")?.use { it.statSize } }.getOrNull() ?: return send(output, 404, "This song's file is no longer there.")
        val range = parseRange(request.headers["range"], size)
        val type = resolver.getType(track.uri) ?: "audio/mpeg"
        val base = mapOf("Content-Type" to type, "Accept-Ranges" to "bytes", "Cache-Control" to "no-store")
        if (range != null && range.isEmpty()) {
            writeHead(output, 416, base + mapOf("Content-Range" to "bytes */$size", "Content-Length" to "0"))
            return output.flush()
        }
        val span = range ?: 0L until size
        writeHead(output, if (range != null) 206 else 200, base + mapOf("Content-Length" to (span.last - span.first + 1).toString()) + (if (range != null) mapOf("Content-Range" to "bytes ${span.first}-${span.last}/$size") else emptyMap()))
        if (head) return output.flush()
        resolver.openInputStream(track.uri)?.use { stream ->
            var skip = span.first
            while (skip > 0) { val n = stream.skip(skip); if (n <= 0) break; skip -= n }
            var left = span.last - span.first + 1
            val buffer = ByteArray(64 * 1024)
            while (left > 0) {
                val n = stream.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
                if (n < 0) break
                output.write(buffer, 0, n)
                left -= n
            }
        }
        output.flush()
    }
}
