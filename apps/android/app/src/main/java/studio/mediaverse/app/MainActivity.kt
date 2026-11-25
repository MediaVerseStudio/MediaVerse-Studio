package studio.mediaverse.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The phone's screen: the web front end (web/app/phone) in a WebView, served from the app's own files at
 * https://appassets.androidplatform.net, talking to the player through one message channel ([NativeBridge]).
 * Playback itself lives in [PlaybackService], so music goes on with the screen off or the app closed.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private var reply: JavaScriptReplyProxy? = null
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    /** Requests to servers on the home network (slow ones must not hold up the rest). */
    private val network = Executors.newFixedThreadPool(4)

    private val askAudio = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            worker.execute { Library.reload(this); main.post { send(JSONObject().put("type", "libraryChanged")) } }
            askImagesOnce()
            askNotificationsOnce()
        } else send(JSONObject().put("type", "permission").put("granted", false))
    }

    /** Album folder pictures (cover.jpg, folder.jpg) are pictures, so reading them needs the images permission. */
    private val askImages = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            ArtProvider.forgetMissing(this)
            send(JSONObject().put("type", "libraryChanged"))
        }
    }

    /** Android's one-time permission for the app to update songs the person already had on the phone (D178): the answer goes back to the page. */
    private var pendingWrite: String? = null
    private val askWrite = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        val id = pendingWrite ?: return@registerForActivityResult
        pendingWrite = null
        send(JSONObject().put("type", "writeGranted").put("id", id).put("ok", result.resultCode == RESULT_OK))
    }

    /** Notifications (the playing and casting notifications, with their buttons) need their own permission on Android 13+. */
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private fun askNotificationsOnce() {
        if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("permissions", MODE_PRIVATE)
        if (prefs.getBoolean("askedNotifications", false)) return
        prefs.edit().putBoolean("askedNotifications", true).apply()
        askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun askImagesOnce() {
        if (Build.VERSION.SDK_INT < 33 || ArtProvider.canReadImages(this)) return
        val prefs = getSharedPreferences("permissions", MODE_PRIVATE)
        if (prefs.getBoolean("askedImages", false)) return
        prefs.edit().putBoolean("askedImages", true).apply()
        askImages.launch(Manifest.permission.READ_MEDIA_IMAGES)
    }

    private val askNetwork = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) worker.execute { ShareServer.setEnabled(this, true) }
        else send(JSONObject().put("type", "shareRefused"))
    }

    /** What the Settings page shows about sharing with the TV, and a pairing code while a TV pairs. */
    private fun sendShare() {
        val devices = JSONArray()
        for (device in ShareServer.devices(this)) devices.put(JSONObject().put("id", device.id).put("name", device.name).put("paired", device.paired))
        val pairing = ShareServer.pairing?.takeIf { it.expires > System.currentTimeMillis() }
        send(
            JSONObject().put("type", "share")
                .put("enabled", ShareServer.enabled(this))
                .put("running", ShareServer.running)
                .put("problem", ShareServer.problem ?: JSONObject.NULL)
                .put("port", ShareServer.PORT)
                .put("name", ShareServer.deviceName())
                .put("addresses", JSONArray(ShareServer.addresses()))
                .put("devices", devices)
                .put("armed", if (ShareServer.pairingArmed()) ShareServer.armedUntil else JSONObject.NULL)
                .put("pairing", pairing?.let { JSONObject().put("name", it.name).put("code", it.code).put("expires", it.expires) } ?: JSONObject.NULL),
        )
    }

    /** TVs playing from the phone that can take commands, with what each is playing. */
    private fun sendTvs() {
        val list = JSONArray()
        for (tv in ShareServer.listening()) list.put(JSONObject().put("id", tv.id).put("name", tv.name).put("state", tv.state ?: JSONObject.NULL))
        // Cast devices (Google Cast, DLNA) are listed the same way: the page treats them as TVs.
        for ((id, name, state) in CastHub.tvs()) list.put(JSONObject().put("id", id).put("name", name).put("state", state ?: JSONObject.NULL))
        send(JSONObject().put("type", "tvs").put("tvs", list))
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // Dark only: light status and gesture bar icons whatever the phone's own theme.
        enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.setBackgroundColor(0xFF0B0806.toInt())
        setContentView(web)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/media/", MediaPathHandler())
            .build()
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Links to the web (MusicBrainz and the like) open in the browser, never inside the app.
                if (request.url.host != ORIGIN_HOST) startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return request.url.host != ORIGIN_HOST
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "mvNative", setOf("https://$ORIGIN_HOST")) { _, message, origin, isMainFrame, proxy ->
                if (!isMainFrame || origin.host != ORIGIN_HOST) return@addWebMessageListener
                reply = proxy
                message.data?.let { onMessage(it) }
            }
        }
        // The page keeps its controls clear of the status bar, the camera and the gesture bar.
        ViewCompat.setOnApplyWindowInsetsListener(web) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val density = resources.displayMetrics.density
            insetsCss = JSONObject().put("top", bars.top / density).put("bottom", bars.bottom / density).put("left", bars.left / density).put("right", bars.right / density)
            send(JSONObject().put("type", "insets").put("insets", insetsCss))
            insets
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.mvBack ? window.mvBack() : false") { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })
        web.loadUrl("https://$ORIGIN_HOST/assets/web/index.html${if (intent?.getBooleanExtra(EXTRA_OPEN_PLAYING, false) == true) "#playing" else ""}")
    }

    private var insetsCss: JSONObject? = null

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_PLAYING, false)) send(JSONObject().put("type", "openPlaying"))
        // Debug builds only: `adb shell am start ... --es cast_test "Den TV" [--es cast_action pause|next|toggle]` plays the first
        // songs of the library on the named cast device, to try casting without touching the phone.
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            intent.getStringExtra("cast_test")?.let { name ->
                val action = intent.getStringExtra("cast_action") ?: "play"
                worker.execute {
                    val device = CastHub.found().firstOrNull { it.name.contains(name, ignoreCase = true) }
                    if (device == null) { android.util.Log.i(CastConnection.TAG, "cast test: no device called $name"); return@execute }
                    val ids = JSONArray(Library.get(this).tracks.take(3).map { it.id.toString() })
                    // cast_near_end: start the first song 12 seconds from its end, to see the next one follow.
                    val first = Library.get(this).tracks.firstOrNull()
                    val from = if (intent.getBooleanExtra("cast_near_end", false) && first != null) maxOf(0L, first.durationMs - 12_000) else 0L
                    CastHub.command(this, device.id, JSONObject().put("action", action).put("ids", ids).put("index", 0).put("position_ms", from))
                    // cast_volume: set the device volume (0 to 1) right after the song loads, e.g. 0.05 to keep tests quiet.
                    if (intent.hasExtra("cast_volume")) {
                        Thread.sleep(1500)
                        CastHub.command(this, device.id, JSONObject().put("action", "volume").put("level", intent.getStringExtra("cast_volume")?.toDoubleOrNull() ?: 0.05))
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        ShareServer.onChange = { sendShare() }
        ShareServer.onRemote = { sendTvs() }
        CastHub.onChange = { main.post { sendTvs() } }
        startCastSearch()
        worker.execute { ShareServer.start(this) }
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        controllerFuture = future
        future.addListener({
            val c = runCatching { future.get() }.getOrNull() ?: return@addListener
            controller = c
            c.addListener(object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) = sendState()
            })
            sendState()
        }, MoreExecutors.directExecutor())
        ticker.run()
    }

    /** Looks for Cast and DLNA devices while the app is showing; Android 17 asks first for local network access. */
    private fun startCastSearch() {
        if (Build.VERSION.SDK_INT >= 37 && ContextCompat.checkSelfPermission(this, LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED) {
            if (!askedCastNetwork) { askedCastNetwork = true; askCastNetwork.launch(LOCAL_NETWORK) }
            return
        }
        worker.execute { CastHub.startDiscovery(this) }
    }

    private var askedCastNetwork = false
    private val askCastNetwork = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) worker.execute { CastHub.startDiscovery(this) }
    }

    override fun onStop() {
        CastHub.stopDiscovery()
        main.removeCallbacks(ticker)
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controller = null
        super.onStop()
    }

    override fun onDestroy() {
        worker.shutdown()
        web.destroy()
        super.onDestroy()
    }

    /**
     * The position, every two seconds while playing (heat pass, 2026-11-17; was every half second). The page counts the
     * time between messages itself (`positionNow`), and every real change (a seek, a new song, pause) is sent at once by
     * the player's listener, so this only corrects drift.
     */
    private val ticker = object : Runnable {
        override fun run() {
            if (controller?.isPlaying == true) sendState(queue = false)
            main.postDelayed(this, 2000)
        }
    }

    private fun hasAudioPermission(): Boolean {
        val permission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun send(message: JSONObject) {
        val proxy = reply ?: return
        main.post { runCatching { proxy.postMessage(message.toString()) } }
    }

    /** What the page asks for. Everything is checked: the page is trusted, but a bad message must not crash. */
    private fun onMessage(text: String) {
        val message = runCatching { JSONObject(text) }.getOrNull() ?: return
        val c = controller
        when (message.optString("type")) {
            "hello" -> {
                if (hasAudioPermission()) { askImagesOnce(); askNotificationsOnce() }
                send(JSONObject().put("type", "hello").put("permission", hasAudioPermission()).put("version", BuildConfigInfo.version(this)).put("insets", insetsCss ?: JSONObject()))
                sendState()
            }
            "askPermission" -> askAudio.launch(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE)
            "library" -> worker.execute {
                val library = if (message.optBoolean("reload")) Library.reload(this) else Library.get(this)
                send(JSONObject().put("type", "library").put("tracks", library.toJson()))
            }
            "play" -> {
                val ids = message.optJSONArray("ids") ?: return
                val items = (0 until ids.length()).map { MediaItem.Builder().setMediaId("track:${ids.optString(it)}").build() }
                if (items.isEmpty() || c == null) return
                c.shuffleModeEnabled = message.optBoolean("shuffle", false)
                c.setMediaItems(items, message.optInt("index", 0).coerceIn(0, items.size - 1), 0)
                c.prepare()
                c.play()
            }
            "enqueue" -> {
                val ids = message.optJSONArray("ids") ?: return
                val items = (0 until ids.length()).map { MediaItem.Builder().setMediaId("track:${ids.optString(it)}").build() }
                if (c == null || items.isEmpty()) return
                if (message.optBoolean("next")) c.addMediaItems((c.currentMediaItemIndex + 1).coerceAtMost(c.mediaItemCount), items) else c.addMediaItems(items)
                if (c.playbackState == Player.STATE_IDLE) c.prepare()
            }
            "favorites" -> send(JSONObject().put("type", "favorites").put("ids", JSONArray(Favorites.all(this).toList())))
            "favorite" -> {
                val id = message.optString("id").takeIf { it.toLongOrNull() != null } ?: return
                Favorites.set(this, id, message.optBoolean("on"))
                PlaybackService.refresh?.invoke()
                send(JSONObject().put("type", "favorites").put("ids", JSONArray(Favorites.all(this).toList())))
            }
            "share" -> sendShare()
            "tvs" -> sendTvs()
            "tvSend" -> {
                val target = message.optString("target")
                val command = message.optJSONObject("command") ?: return
                val action = command.optString("action")
                if (CastHub.owns(target) && action in setOf("play", "toggle", "pause", "next", "previous", "seek", "stop", "shuffle", "repeat", "volume")) {
                    worker.execute { CastHub.command(this, target, command) }
                } else if (ShareServer.listening().any { it.id == target } && action in setOf("play", "toggle", "pause", "next", "previous", "seek")) {
                    worker.execute { ShareServer.sendToTv(target, command) }
                }
            }
            "shareSet" -> {
                val on = message.optBoolean("on")
                if (on && Build.VERSION.SDK_INT >= 37 && ContextCompat.checkSelfPermission(this, LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED) askNetwork.launch(LOCAL_NETWORK)
                else worker.execute { ShareServer.setEnabled(this, on) }
            }
            "shareArm" -> worker.execute { ShareServer.armPairing() }
            "shareRemove" -> worker.execute { ShareServer.removeDevice(this, message.optString("id")) }
            "toggle" -> c?.let { if (it.isPlaying) it.pause() else { if (it.playbackState == Player.STATE_IDLE) it.prepare(); if (it.playbackState == Player.STATE_ENDED) it.seekToDefaultPosition(0); it.play() } }
            "next" -> c?.seekToNextMediaItem()
            "previous" -> c?.let { if (it.currentPosition > 3000 || !it.hasPreviousMediaItem()) it.seekTo(0) else it.seekToPreviousMediaItem() }
            "seek" -> c?.seekTo(message.optLong("ms", 0).coerceAtLeast(0))
            "jump" -> c?.let { val i = message.optInt("index", -1); if (i in 0 until it.mediaItemCount) { it.seekToDefaultPosition(i); it.play() } }
            "remove" -> c?.let { val i = message.optInt("index", -1); if (i in 0 until it.mediaItemCount) it.removeMediaItem(i) }
            "eq" -> send(JSONObject().put("type", "eq").put("eq", OutputEq.state()))
            "eqSet" -> {
                val levels = message.optJSONArray("levels")?.let { a -> (0 until a.length()).map { a.optInt(it, 0) } } ?: return
                OutputEq.set(message.optString("key"), message.optBoolean("enabled"), levels)
                send(JSONObject().put("type", "eq").put("eq", OutputEq.state()))
            }
            "http" -> network.execute { send(HomeHttp.handle(message)) }
            // Keeping music from the home server on the phone (D177): is the phone on Wi-Fi, fetch one song, take songs off.
            "network" -> send(HomeSync.network(this))
            "download" -> network.execute {
                val id = message.optString("id")
                send(HomeSync.download(this, message) { bytes, total -> send(JSONObject().put("type", "downloadProgress").put("id", id).put("bytes", bytes).put("total", total)) })
            }
            "fingerprint" -> network.execute { send(HomeSync.fingerprint(this, message)) }
            "grantWrite" -> {
                val id = message.optString("id")
                val ids = message.optJSONArray("ids")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
                val uris = HomeSync.uris(ids)
                if (uris.isEmpty() || pendingWrite != null) {
                    send(JSONObject().put("type", "writeGranted").put("id", id).put("ok", false))
                } else {
                    pendingWrite = id
                    askWrite.launch(IntentSenderRequest.Builder(MediaStore.createWriteRequest(contentResolver, uris).intentSender).build())
                }
            }
            "deleteLocal" -> worker.execute {
                val ids = message.optJSONArray("ids")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
                send(HomeSync.deleted(message.optString("id"), HomeSync.delete(this, ids)))
                Library.reload(this)
                main.post { send(JSONObject().put("type", "libraryChanged")) }
            }
            "lyrics" -> {
                // The lyrics saved in the song's tags, read off the main thread; the page matches the reply by song ID.
                val id = message.optString("id")
                worker.execute {
                    val track = id.toLongOrNull()?.let { Library.get(this).byId[it] }
                    val found = track?.let { Lyrics.read(this, it) }
                    send(JSONObject().put("type", "lyrics").put("id", id).put("lyrics", found?.toJson() ?: Lyrics.none))
                }
            }
            "stats" -> send(JSONObject().put("type", "stats").put("stats", PlayStats.all(this)))
            "sleep" -> {
                // minutes > 0: count down with a fade; "song": stop when this song ends; 0: cancel.
                if (message.optBoolean("song")) SleepTimer.endOfSong() else SleepTimer.start(message.optInt("minutes", 0).coerceIn(0, 600))
                sendState(queue = false)
            }
            "ab" -> { c?.let { AbRepeat.step(it.currentPosition) }; sendState(queue = false) }
            "shuffle" -> c?.let { it.shuffleModeEnabled = !it.shuffleModeEnabled }
            "repeat" -> c?.let { it.repeatMode = when (it.repeatMode) { Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL; Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE; else -> Player.REPEAT_MODE_OFF } }
        }
    }

    /** The player's state for the page; the queue (song IDs, in play order) only when it changed. */
    private fun sendState(queue: Boolean = true) {
        val c = controller ?: return
        val state = JSONObject()
            .put("type", "state")
            .put("playing", c.isPlaying)
            .put("buffering", c.playbackState == Player.STATE_BUFFERING)
            .put("index", c.currentMediaItemIndex)
            .put("id", c.currentMediaItem?.mediaId?.let { Browse.idOf(it)?.toString() } ?: JSONObject.NULL)
            .put("position", c.currentPosition.coerceAtLeast(0))
            .put("duration", c.duration.takeIf { it > 0 } ?: 0)
            .put("shuffle", c.shuffleModeEnabled)
            .put("repeat", when (c.repeatMode) { Player.REPEAT_MODE_ALL -> "all"; Player.REPEAT_MODE_ONE -> "one"; else -> "off" })
            .put("sleep_ms", SleepTimer.remainingMs())
            .put("sleep_song", SleepTimer.waitingForSongEnd())
            .put("ab_a", AbRepeat.a)
            .put("ab_b", AbRepeat.b)
        if (queue) {
            val ids = (0 until c.mediaItemCount).map { Browse.idOf(c.getMediaItemAt(it).mediaId)?.toString() ?: "" }
            // In shuffle the queue is shown in the order it will play.
            val order = ArrayList<Int>()
            val timeline = c.currentTimeline
            if (!timeline.isEmpty) {
                var i = timeline.getFirstWindowIndex(c.shuffleModeEnabled)
                while (i != androidx.media3.common.C.INDEX_UNSET && order.size < ids.size) {
                    order += i
                    i = timeline.getNextWindowIndex(i, Player.REPEAT_MODE_OFF, c.shuffleModeEnabled)
                }
            }
            state.put("queue", JSONArray(ids)).put("order", JSONArray(order))
        }
        send(state)
    }

    /** Covers and audio for the page: /media/cover/<id>?size=320 and /media/audio/<id> (the visualizer reads it). */
    private inner class MediaPathHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val parts = path.split('/')
            val id = parts.getOrNull(1)?.substringBefore('?')?.toLongOrNull() ?: return notFound()
            return when (parts.getOrNull(0)) {
                "cover" -> {
                    val size = Uri.parse("x://x/$path").getQueryParameter("size")?.toIntOrNull() ?: 320
                    val file = ArtProvider.cover(this@MainActivity, id, ArtProvider.fit(size)) ?: return notFound()
                    WebResourceResponse("image/jpeg", null, file.inputStream()).apply { responseHeaders = mapOf("Cache-Control" to "max-age=86400") }
                }
                "audio" -> {
                    val track = Library.get(this@MainActivity).byId[id] ?: return notFound()
                    val stream = runCatching { contentResolver.openInputStream(track.uri) }.getOrNull() ?: return notFound()
                    WebResourceResponse("audio/mpeg", null, stream)
                }
                else -> notFound()
            }
        }

        private fun notFound() = WebResourceResponse("text/plain", null, 404, "Not found", emptyMap(), null)
    }

    companion object {
        const val ORIGIN_HOST = "appassets.androidplatform.net"
        const val EXTRA_OPEN_PLAYING = "open_playing"
        const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}

object BuildConfigInfo {
    fun version(context: android.content.Context): String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: ""
}
