package studio.mediaverse.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.provider.MediaStore
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** What the hub needs from a device, whatever protocol it speaks (Google Cast here; DLNA in [DlnaTarget]). */
interface CastTarget {
    fun load(song: CastSong, startSeconds: Double)
    fun play()
    fun pause()
    fun seek(seconds: Double)
    fun status(): CastStatus
    fun stop()
    fun close()
    /** The device's volume, 0.0 to 1.0. Devices that cannot be told ignore it. */
    fun setVolume(level: Double) {}
    /** True when the device can be told which song follows the one playing, and then starts it by itself (no gap). */
    val canPreload: Boolean get() = false
    /** Tells the device the song that follows the current one. Only called when [canPreload]. */
    fun preloadNext(song: CastSong) {}
}

/**
 * Casting from the phone (owner, 2026-11-11): finds Google Cast devices (and DLNA renderers) on the home network and
 * plays the phone's queue on one. A device shows in the phone's "Play on the TV" list beside the TVs that run the
 * MediaVerse Studio app, takes the same commands (play from here, pause, next, previous, seek) and reports the same
 * state, so the page treats them alike. The device fetches each song from the phone's own server with a link carrying
 * a random token (see [ShareServer.castUrl]); nothing is paired. The next song is loaded here when one ends.
 * Home network only. Ported from the computer's googlecast.js and dlna.js; not yet proven on every device.
 */
object CastHub {
    data class Device(val id: String, val name: String, val model: String, val host: String, val port: Int, val kind: String, val control: String? = null, val service: String? = null, val rendering: String? = null, val renderingService: String = Dlna.RENDERING_CONTROL)

    private const val TAG = CastConnection.TAG
    private val devices = ConcurrentHashMap<String, Device>()
    private val playing = ConcurrentHashMap<String, Playing>()

    /** Told when the device list or what a device plays changes. */
    @Volatile var onChange: () -> Unit = {}

    // ---------- Finding devices ----------

    private var manager: NsdManager? = null
    private var listener: NsdManager.DiscoveryListener? = null
    private val toResolve = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private val byServiceName = ConcurrentHashMap<String, String>()

    @Synchronized
    fun startDiscovery(context: Context) {
        if (listener != null) return
        val nsd = context.applicationContext.getSystemService(NsdManager::class.java) ?: return
        val discovery = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { Log.i(TAG, "cast search failed: $errorCode"); stopDiscovery() }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) { synchronized(toResolve) { toResolve.addLast(info) }; resolveNext() }
            override fun onServiceLost(info: NsdServiceInfo) {
                byServiceName.remove(info.serviceName)?.let { id -> if (!playing.containsKey(id)) devices.remove(id) }
                onChange()
            }
        }
        listener = discovery
        manager = nsd
        runCatching { nsd.discoverServices("_googlecast._tcp", NsdManager.PROTOCOL_DNS_SD, discovery) }.onFailure { Log.i(TAG, "cast search: ${it.message}"); listener = null }
        // DLNA renderers (Samsung TVs without the app, speakers): an SSDP search now and every half minute.
        val app = context.applicationContext
        Thread({
            while (listener === discovery) {
                try {
                    for (r in Dlna.search(app)) {
                        val id = "dlna:${r.id}"
                        val known = devices[id]
                        devices[id] = Device(id, r.name, r.model.ifBlank { "DLNA" }, r.host, 0, "dlna", r.control, r.service, r.rendering, r.renderingService)
                        if (known == null) { Log.i(TAG, "dlna device: ${r.name} at ${r.host}"); onChange() }
                    }
                    Thread.sleep(30_000)
                } catch (_: InterruptedException) {
                    return@Thread
                } catch (error: Exception) {
                    Log.i(TAG, "dlna search: ${error.message}")
                    try { Thread.sleep(30_000) } catch (_: InterruptedException) { return@Thread }
                }
            }
        }, "dlna-search").apply { isDaemon = true }.start()
    }

    @Synchronized
    fun stopDiscovery() {
        val l = listener ?: return
        runCatching { manager?.stopServiceDiscovery(l) }
        listener = null
    }

    private fun resolveNext() {
        val info = synchronized(toResolve) {
            if (resolving || toResolve.isEmpty()) return
            resolving = true
            toResolve.removeFirst()
        }
        val done = {
            synchronized(toResolve) { resolving = false }
            resolveNext()
        }
        val nsd = manager ?: return done()
        runCatching {
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = done()
                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val host = serviceInfo.host?.hostAddress
                    if (host != null && ShareServer.isHomeNetworkAddress(host)) {
                        fun text(key: String) = serviceInfo.attributes[key]?.toString(Charsets.UTF_8)?.takeIf { it.isNotBlank() }
                        val id = "cast:${text("id") ?: serviceInfo.serviceName}"
                        devices[id] = Device(id, text("fn") ?: serviceInfo.serviceName, text("md") ?: "Google Cast", host, serviceInfo.port, "cast")
                        byServiceName[serviceInfo.serviceName] = id
                        Log.i(TAG, "cast device: ${text("fn")} at $host:${serviceInfo.port}")
                        onChange()
                    }
                    done()
                }
            })
        }.onFailure { done() }
    }

    /** Devices to offer. A TV or speaker that speaks both Google Cast and DLNA is offered once, as Cast (richer). */
    fun found(): List<Device> {
        val castHosts = devices.values.filter { it.kind == "cast" }.map { it.host }.toSet()
        return devices.values.filter { it.kind != "dlna" || it.host !in castHosts }.sortedBy { it.name.lowercase() }
    }

    /** Stops every cast and closes the players on the devices (the notification's Stop button). */
    fun stopAll(context: Context) {
        for ((id, now) in playing.entries.toList()) {
            playing.remove(id, now)
            now.stop(closeDevice = true)
        }
        refreshService(context)
        onChange()
    }

    /** The volume (0 to 1) of the device that is playing now, or null when unknown (for the phone's volume keys). */
    fun activeVolume(): Double? = playing.values.firstOrNull()?.currentVolume()?.takeIf { it >= 0 }

    /** Sets the volume of the device that is playing now (the phone's volume keys). Off the main thread. */
    fun setActiveVolume(level: Double) {
        val now = playing.values.firstOrNull() ?: return
        Thread({ runCatching { now.setVolume(level) }.onFailure { Log.i(TAG, "volume: ${it.message}") } }, "cast-volume").start()
    }

    private fun refreshService(context: Context) {
        val now = playing.values.firstOrNull()
        if (now != null) CastService.start(context.applicationContext, now.device.name) else CastService.stop(context.applicationContext)
    }

    // ---------- The list the page shows, and its commands ----------

    fun owns(target: String): Boolean = devices.containsKey(target)

    /** Cast devices as the page's TVs: id, name, and what each plays (null when nothing is cast to it). */
    fun tvs(): List<Triple<String, String, JSONObject?>> = found().map { Triple(it.id, it.name, playing[it.id]?.state) }

    fun command(context: Context, target: String, command: JSONObject) {
        val device = devices[target] ?: return
        val action = command.optString("action")
        Log.i(TAG, "cast $action on ${device.name}")
        try {
            if (action == "play") {
                val ids = command.optJSONArray("ids")?.let { a -> (0 until a.length()).mapNotNull { a.optString(it).toLongOrNull() } } ?: return
                val index = command.optInt("index", 0)
                if (index !in ids.indices) return
                ShareServer.startForCasting(context)
                playing.remove(target)?.stop(closeDevice = false)
                val now = Playing(context.applicationContext, device, ids, index)
                playing[target] = now
                now.start(command.optLong("position_ms", 0) / 1000.0)
                refreshService(context)
                return
            }
            if (action == "stop") {
                // Closes the player on the device, so it goes back to what it showed before (also for a cast left by an earlier run).
                val known = playing.remove(target)
                if (known != null) known.stop(closeDevice = true) else targetFor(device).let { t -> runCatching { t.stop() }; runCatching { t.close() } }
                refreshService(context)
                onChange()
                return
            }
            val now = playing[target] ?: return
            when (action) {
                "toggle" -> if (now.state?.optBoolean("playing") == true) now.target.pause() else now.target.play()
                "pause" -> now.target.pause()
                "next" -> now.next()
                "previous" -> now.previous()
                "shuffle" -> now.toggleShuffle()
                "repeat" -> now.cycleRepeat()
                "seek" -> now.target.seek(command.optLong("ms", 0) / 1000.0)
                "volume" -> command.optDouble("level", -1.0).takeIf { it in 0.0..1.0 }?.let { now.setVolume(it) }
            }
        } catch (error: Exception) {
            Log.i(TAG, "cast command $action: ${error.message}")
            playing.remove(target)?.stop(closeDevice = true)
            refreshService(context)
            onChange()
        }
    }

    private fun targetFor(device: Device): CastTarget = when (device.kind) {
        "dlna" -> DlnaTarget(device.control ?: throw IllegalStateException("no control address"), device.service ?: Dlna.AV_TRANSPORT, device.rendering, device.renderingService)
        else -> CastSession(device.host, device.port)
    }

    /** One device playing a queue: loads each song, watches the device and loads the next when one finishes. */
    private class Playing(val context: Context, val device: Device, ids: List<Long>, start: Int) {
        val target: CastTarget = targetFor(device)
        val queue = CastQueue(ids, start)
        @Volatile var state: JSONObject? = null
        @Volatile private var stopped = false
        @Volatile private var loadedAt = 0L
        // What the device last said while this song played, to know that it finished: Google's player reports an empty
        // status (no media) once a song has ended, not always "finished".
        @Volatile private var sawPlaying = false
        @Volatile private var lastPosition = 0.0
        @Volatile private var lastDuration = 0.0
        @Volatile private var volume = -1.0
        // Gapless: the device was told which song follows (`nextUrl`), and starts it by itself. `itemAtLoad` is the device's
        // own number for the song loaded last (a different number later means it moved on); the links say which song is which.
        @Volatile private var currentUrl = ""
        @Volatile private var nextUrl: String? = null
        @Volatile private var itemAtLoad = 0
        private var stoppedPolls = 0

        fun currentVolume(): Double = volume

        fun setVolume(level: Double) {
            target.setVolume(level)
            volume = level
            state?.put("volume", level)
            onChange()
        }

        fun start(startSeconds: Double) {
            load(queue.index, startSeconds)
            Thread({ watch() }, "cast-watch").apply { isDaemon = true }.start()
        }

        /** The state the page shows (the same words a TV running the app uses), with shuffle and repeat added. */
        private fun report(playing: Boolean, positionMs: Long, durationMs: Long) {
            state = JSONObject().put("id", queue.current.toString()).put("playing", playing).put("position_ms", positionMs)
                .put("duration_ms", durationMs).put("at", System.currentTimeMillis()).put("shuffle", queue.shuffle).put("repeat", queue.repeat)
            if (volume >= 0) state?.put("volume", volume)
        }

        @Synchronized
        private fun load(i: Int, startSeconds: Double) {
            if (stopped) return // stopped (the notification's Stop button, the phone's TV button): nothing more is sent
            queue.moveTo(i)
            val song = song(context, queue.current) ?: throw IllegalStateException("That song is not on the phone any more.")
            Log.i(TAG, "loading ${song.title} on ${device.name}: ${song.url}")
            target.load(song, startSeconds)
            Log.i(TAG, "${device.name} is playing ${song.title}")
            loadedAt = System.currentTimeMillis()
            sawPlaying = false
            lastPosition = startSeconds
            lastDuration = song.seconds
            currentUrl = song.url
            nextUrl = null
            itemAtLoad = 0
            stoppedPolls = 0
            report(true, (startSeconds * 1000).toLong(), (song.seconds * 1000).toLong())
            onChange()
            preloadAhead()
        }

        /** Tells the device which song follows this one, when it can start it by itself (no gap between songs). */
        private fun preloadAhead() {
            if (!target.canPreload || queue.repeat == "one") return // repeating one song: loaded again when it ends
            val after = queue.afterEnd() ?: return
            val song = song(context, queue.ids[after]) ?: return
            runCatching {
                target.preloadNext(song)
                nextUrl = song.url
                Log.i(TAG, "${device.name}: next is ${song.title}, ready on the device")
            }.onFailure { Log.i(TAG, "${device.name}: could not queue the next song: ${it.message}") }
        }

        /** Loads the current song again at the place it has reached: the song that follows it changed (shuffle, repeat). */
        private fun reloadHere() {
            if (nextUrl == null) return // nothing was queued on the device: the next song is chosen when this one ends
            load(queue.index, (state?.optLong("position_ms") ?: 0) / 1000.0)
        }

        /** The device started the song it was told about: the queue moves on without a load. */
        private fun deviceMovedOn(s: CastStatus) {
            val after = queue.afterEnd() ?: return
            queue.moveTo(after)
            Log.i(TAG, "${device.name} moved on by itself to song ${queue.index + 1}")
            loadedAt = System.currentTimeMillis()
            sawPlaying = true
            lastPosition = s.position
            lastDuration = s.duration
            currentUrl = s.contentId
            itemAtLoad = s.itemId
            nextUrl = null
            stoppedPolls = 0
            report(true, (s.position * 1000).toLong(), (s.duration * 1000).toLong())
            onChange()
            preloadAhead()
        }

        fun next() { queue.afterNext()?.let { load(it, 0.0) } }

        fun previous() {
            val position = state?.optLong("position_ms") ?: 0
            if (position > 3000 || queue.index == 0) target.seek(0.0) else load(queue.index - 1, 0.0)
        }

        /** The phone's shuffle button, applied to this queue. */
        fun toggleShuffle() {
            queue.toggleShuffle()
            Log.i(TAG, "${device.name}: shuffle ${queue.shuffle}, queue ${queue.ids.take(3)}")
            state?.put("shuffle", queue.shuffle)
            onChange()
            reloadHere()
        }

        /** The phone's repeat button (off, all, one), applied to this queue. */
        fun cycleRepeat() {
            queue.cycleRepeat()
            Log.i(TAG, "${device.name}: repeat ${queue.repeat}")
            state?.put("repeat", queue.repeat)
            onChange()
            reloadHere()
        }

        private fun watch() {
            var failures = 0
            while (!stopped) {
                try {
                    // Every 1.5 s, but every 0.5 s in the last ten seconds of a song: the next song starts as soon as the end is
                    // seen, so the gap between songs is as short as this protocol allows without a queue on the device.
                    Thread.sleep(if (lastDuration > 0 && lastPosition >= lastDuration - 10) 500 else 1500)
                    val s = target.status()
                    if (stopped) return // its "stopped" answer was to our own stop, not the song ending
                    failures = 0
                    if (s.state == "PLAYING") sawPlaying = true
                    if (s.volume >= 0) volume = s.volume
                    if (s.state != "STOPPED") {
                        lastPosition = s.position
                        if (s.duration > 0) lastDuration = s.duration
                    }
                    Log.i(TAG, "${device.name}: ${s.state} ${s.position.toInt()}/${s.duration.toInt()}s finished=${s.finished} item=${s.itemId}")
                    // The device's own number for the song it plays, noted once it plays the one we loaded last.
                    if (itemAtLoad == 0 && s.itemId != 0 && s.contentId == currentUrl && s.state != "STOPPED") itemAtLoad = s.itemId
                    // The song told to the device ahead of time began by itself: follow it without loading anything.
                    val queued = nextUrl
                    if (queued != null && itemAtLoad != 0 && s.itemId != 0 && s.itemId != itemAtLoad && s.contentId == queued && (s.state == "PLAYING" || s.state == "TRANSITIONING")) {
                        deviceMovedOn(s)
                        continue
                    }
                    // Stopped after playing, and either said so, has no media any more, or was near the end: it ended.
                    val ended = s.state == "STOPPED" && sawPlaying && (s.finished || s.contentId.isBlank() || (lastDuration > 0 && lastPosition >= lastDuration - 6))
                    // With a song queued the device may pass through "stopped" for a moment between two songs: look again before loading.
                    stoppedPolls = if (ended) stoppedPolls + 1 else 0
                    if (ended && System.currentTimeMillis() - loadedAt > 4000 && (nextUrl == null || stoppedPolls >= 3)) {
                        val after = queue.afterEnd()
                        if (after != null) load(after, 0.0) else { state = null; stop(closeDevice = false); playing.remove(device.id, this); refreshService(context); onChange(); return }
                        continue
                    }
                    report(s.state == "PLAYING" || s.state == "TRANSITIONING", (s.position * 1000).toLong(), (s.duration * 1000).toLong())
                    onChange()
                } catch (error: InterruptedException) {
                    return
                } catch (error: Exception) {
                    if (++failures >= 5) {
                        Log.i(TAG, "cast lost ${device.name}: ${error.message}")
                        state = null
                        stop(closeDevice = false)
                        playing.remove(device.id, this)
                        refreshService(context)
                        onChange()
                        return
                    }
                }
            }
        }

        fun stop(closeDevice: Boolean) {
            stopped = true
            if (closeDevice) runCatching { target.stop() }
            runCatching { target.close() }
        }
    }
    /** A song as a cast device needs it: a link with the phone's cast token, its type, and what to show. */
    private fun song(context: Context, id: Long): CastSong? {
        val track = Library.get(context).byId[id] ?: return null
        val url = ShareServer.castUrl("audio", id) ?: return null
        val audio = android.content.ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)
        val mime = runCatching {
            context.contentResolver.query(audio, arrayOf(MediaStore.MediaColumns.MIME_TYPE), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
        }.getOrNull()?.takeIf { it.startsWith("audio/") } ?: "audio/mpeg"
        // The lyrics ride along with the song (a few kilobytes), for TVs running the MediaVerse receiver.
        val lyrics = Lyrics.read(context, track)?.takeIf { it.synced || !it.plain.isNullOrBlank() }?.toCastJson()
        return CastSong(url, mime, track.title, track.artist, track.album, ShareServer.castUrl("cover", id, "&size=512"), track.durationMs / 1000.0, lyrics)
    }
}
