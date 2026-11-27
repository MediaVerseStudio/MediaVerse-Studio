package studio.mediaverse.app

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.CommandButton
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import java.util.concurrent.Executors

/**
 * Plays the music (ExoPlayer) and offers the library to whoever asks: this app's own screen, the notification and
 * lock screen, and Android Auto, which draws its own screens from the lists given here (Artists, Albums, Genres,
 * Songs). The queue and place are remembered, so playback can be picked up again after the app was closed.
 */
class PlaybackService : MediaLibraryService() {
    private var session: MediaLibrarySession? = null
    private val worker = MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor())
    private val saver = android.os.Handler(android.os.Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_PLAYING, true), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        session = MediaLibrarySession.Builder(this, player, Callback()).setSessionActivity(open).setMediaButtonPreferences(buttons(player)).setCustomLayout(buttons(player)).build()
        SleepTimer.player = player
        OutputEq.attach(this, player)
        refresh = { android.os.Handler(mainLooper).post { refreshButtons() } }
        player.addListener(object : Player.Listener {
            // A song counts as played when it got far enough before the next one began (Most played, Not played yet).
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                val old = oldPosition.mediaItem ?: return
                val changed = reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION || oldPosition.mediaItemIndex != newPosition.mediaItemIndex
                if (!changed) return
                countPlayed(old.mediaId, oldPosition.positionMs)
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) player.currentMediaItem?.let { countPlayed(it.mediaId, player.duration.coerceAtLeast(0)) }
            }

            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) { SleepTimer.songChanged() }

            override fun onEvents(player: Player, events: Player.Events) {
                if (events.containsAny(Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED, Player.EVENT_REPEAT_MODE_CHANGED, Player.EVENT_MEDIA_ITEM_TRANSITION)) refreshButtons()
                if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_TIMELINE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED, Player.EVENT_REPEAT_MODE_CHANGED)) {
                    Resume.save(this@PlaybackService, player)
                }
            }
        })
        // While music plays the place in the song is saved every 5 s, so that if Android ends the app (low memory, a crash) the queue comes back near where it was,
        // not at the last pause or song change (owner, 2026-11-24: queues must survive a relaunch).
        val saveWhilePlaying = object : Runnable {
            override fun run() {
                if (player.isPlaying) Resume.save(this@PlaybackService, player)
                saver.postDelayed(this, 5_000)
            }
        }
        saver.postDelayed(saveWhilePlaying, 5_000)
        // Pick up where the music was left, paused, so the notification, the car and the app show it at once.
        // The TV share (when switched on) runs while the player does.
        worker.submit { ShareServer.start(this) }
        worker.submit {
            val restored = Resume.load(this, Library.get(this)) ?: return@submit
            android.os.Handler(mainLooper).post {
                if (player.mediaItemCount == 0) {
                    player.setMediaItems(restored.items, restored.index, restored.positionMs)
                    player.shuffleModeEnabled = restored.shuffle
                    player.repeatMode = restored.repeat
                    player.prepare()
                }
            }
        }
    }

    /** Shuffle, repeat and favourite as they are now (the heart follows the playing song). */
    private fun refreshButtons() {
        val player = session?.player ?: return
        session?.setMediaButtonPreferences(buttons(player))
        session?.setCustomLayout(buttons(player))
    }

    private fun currentId(player: Player): Long? = player.currentMediaItem?.mediaId?.let { Browse.idOf(it) }

    private fun countPlayed(mediaId: String, positionMs: Long) {
        val id = Browse.idOf(mediaId) ?: return
        val length = Library.get(this).byId[id]?.durationMs ?: 0
        if (PlayStats.counts(positionMs, length)) PlayStats.played(this, id)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    /**
     * Shuffle and repeat beside previous, play and next: in the notification, on the lock screen and in Android
     * Auto. Icons only, showing the current mode (owner, 2026-11-04).
     */
    private fun buttons(player: Player): ImmutableList<CommandButton> {
        val shuffle = CommandButton.Builder(if (player.shuffleModeEnabled) CommandButton.ICON_SHUFFLE_ON else CommandButton.ICON_SHUFFLE_OFF)
            .setDisplayName(if (player.shuffleModeEnabled) "Shuffle: on" else "Shuffle: off")
            .setSessionCommand(SHUFFLE)
            .build()
        val repeat = CommandButton.Builder(
            when (player.repeatMode) {
                Player.REPEAT_MODE_ALL -> CommandButton.ICON_REPEAT_ALL
                Player.REPEAT_MODE_ONE -> CommandButton.ICON_REPEAT_ONE
                else -> CommandButton.ICON_REPEAT_OFF
            },
        )
            .setDisplayName(when (player.repeatMode) { Player.REPEAT_MODE_ALL -> "Repeat: all"; Player.REPEAT_MODE_ONE -> "Repeat: this song"; else -> "Repeat: off" })
            .setSessionCommand(REPEAT)
            .build()
        val liked = currentId(player)?.let { Favorites.all(this).contains(it.toString()) } == true
        val favourite = CommandButton.Builder(if (liked) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED)
            .setDisplayName(if (liked) "Favorite: on" else "Favorite: off")
            .setSessionCommand(FAVORITE)
            .build()
        return ImmutableList.of(shuffle, repeat, favourite)
    }

    /** Swiped away from the recent apps: stop, playing or not (owner, 2026-11-10: closing the app should stop the music).
     *  The place in the queue is kept, so the next start can pick up there. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        player?.let {
            Resume.save(this, it)
            it.pause()
        }
        stopSelf()
    }

    override fun onDestroy() {
        saver.removeCallbacksAndMessages(null)
        refresh = null
        SleepTimer.cancel()
        SleepTimer.player = null
        OutputEq.detach()
        session?.run {
            Resume.save(this@PlaybackService, player)
            player.release()
            release()
        }
        session = null
        worker.shutdown()
        super.onDestroy()
    }

    companion object {
        val SHUFFLE = SessionCommand("studio.mediaverse.SHUFFLE", Bundle.EMPTY)
        val REPEAT = SessionCommand("studio.mediaverse.REPEAT", Bundle.EMPTY)
        val FAVORITE = SessionCommand("studio.mediaverse.FAVORITE", Bundle.EMPTY)

        /** Set while the service runs: redraws the car and notification buttons (the page changed a favourite). */
        @Volatile var refresh: (() -> Unit)? = null
    }

    private inner class Callback : MediaLibrarySession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
            MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon().add(SHUFFLE).add(REPEAT).add(FAVORITE).build())
                .setMediaButtonPreferences(buttons(session.player))
                .setCustomLayout(buttons(session.player))
                .build()

        override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, customCommand: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
            val player = session.player
            when (customCommand.customAction) {
                SHUFFLE.customAction -> player.shuffleModeEnabled = !player.shuffleModeEnabled
                FAVORITE.customAction -> currentId(player)?.let { id ->
                    Favorites.set(this@PlaybackService, id.toString(), !Favorites.all(this@PlaybackService).contains(id.toString()))
                    refreshButtons()
                }
                REPEAT.customAction -> player.repeatMode = when (player.repeatMode) {
                    Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
                    Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
                    else -> Player.REPEAT_MODE_OFF
                }
                else -> return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
            }
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }

        override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> {
            val extras = Bundle().apply {
                putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
                putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
            }
            return Futures.immediateFuture(LibraryResult.ofItem(Browse.folder(Browse.ROOT, getString(R.string.app_name), extras = extras), LibraryParams.Builder().setExtras(extras).build()))
        }

        override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
            worker.submit<LibraryResult<ImmutableList<MediaItem>>> {
                val children = Browse.children(this@PlaybackService, Library.get(this@PlaybackService), parentId)
                    ?: return@submit LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)
                val from = (page.toLong() * pageSize).coerceAtMost(children.size.toLong()).toInt()
                val to = (from.toLong() + pageSize).coerceAtMost(children.size.toLong()).toInt()
                LibraryResult.ofItemList(ImmutableList.copyOf(children.subList(from, to)), params)
            }

        override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> =
            worker.submit<LibraryResult<MediaItem>> {
                val item = Browse.item(this@PlaybackService, Library.get(this@PlaybackService), mediaId)
                if (item != null) LibraryResult.ofItem(item, null) else LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)
            }

        override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> {
            worker.submit {
                val count = Library.get(this@PlaybackService).search(query).size
                session.notifySearchResultChanged(browser, query, count, params)
            }
            return Futures.immediateFuture(LibraryResult.ofVoid())
        }

        override fun onGetSearchResult(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
            worker.submit<LibraryResult<ImmutableList<MediaItem>>> {
                val found = Library.get(this@PlaybackService).search(query)
                val from = (page * pageSize).coerceAtMost(found.size)
                val to = (from + pageSize).coerceAtMost(found.size)
                LibraryResult.ofItemList(ImmutableList.copyOf(found.subList(from, to).map { Browse.playable(this@PlaybackService, it, "search", query) }), params)
            }

        /** Items arrive as IDs only (from this app's screen, the car, or a voice request): make them playable. */
        override fun onAddMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>): ListenableFuture<MutableList<MediaItem>> =
            worker.submit<MutableList<MediaItem>> {
                val library = Library.get(this@PlaybackService)
                mediaItems.flatMap { requested ->
                    val query = requested.requestMetadata.searchQuery
                    if (requested.mediaId.isEmpty() && query != null) library.search(query).map { Browse.playable(this@PlaybackService, it) }
                    else listOfNotNull(Browse.resolve(this@PlaybackService, library, requested.mediaId))
                }.toMutableList()
            }

        /** A song chosen in a list plays with the rest of that list after it (the album, the artist, the genre). */
        override fun onSetMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            val queueAction = mediaItems.singleOrNull()?.mediaId?.takeIf { it.startsWith("act:") }
            if (queueAction != null) return queueChoice(mediaSession.player, queueAction)
            return worker.submit<MediaSession.MediaItemsWithStartPosition> {
                val library = Library.get(this@PlaybackService)
                val single = mediaItems.singleOrNull()?.mediaId
                val expanded = single?.let { Browse.expand(this@PlaybackService, library, it) }
                if (expanded != null) {
                    MediaSession.MediaItemsWithStartPosition(expanded.first, expanded.second, if (startPositionMs == C.TIME_UNSET) 0 else startPositionMs)
                } else {
                    val resolved = mediaItems.flatMap { requested ->
                        val query = requested.requestMetadata.searchQuery
                        if (requested.mediaId.isEmpty() && query != null) library.search(query).map { Browse.playable(this@PlaybackService, it) }
                        else listOfNotNull(Browse.resolve(this@PlaybackService, library, requested.mediaId))
                    }
                    MediaSession.MediaItemsWithStartPosition(resolved, startIndex.coerceIn(0, (resolved.size - 1).coerceAtLeast(0)), startPositionMs)
                }
            }
        }

        /**
         * "Play all", "Shuffle all" and "Add all to queue" from the car. The first two replace the queue; "add" puts the
         * songs after the last one and hands back the queue as it is, at the same place, so the song keeps playing.
         */
        private fun queueChoice(player: Player, mediaId: String): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            val result = com.google.common.util.concurrent.SettableFuture.create<MediaSession.MediaItemsWithStartPosition>()
            worker.submit {
                try {
                    val (what, tracks) = Browse.action(Library.get(this@PlaybackService), mediaId) ?: throw IllegalArgumentException("Unknown choice")
                    val items = tracks.map { Browse.playable(this@PlaybackService, it) }
                    android.os.Handler(mainLooper).post {
                        try {
                            when {
                                what == "add" && player.mediaItemCount > 0 -> {
                                    player.addMediaItems(items)
                                    val queue = (0 until player.mediaItemCount).map { player.getMediaItemAt(it) }
                                    result.set(MediaSession.MediaItemsWithStartPosition(queue, player.currentMediaItemIndex, player.currentPosition))
                                }
                                what == "shuffle" -> result.set(MediaSession.MediaItemsWithStartPosition(items.shuffled(), 0, 0))
                                else -> result.set(MediaSession.MediaItemsWithStartPosition(items, 0, 0))
                            }
                        } catch (e: Exception) {
                            result.setException(e)
                        }
                    }
                } catch (e: Exception) {
                    result.setException(e)
                }
            }
            return result
        }
    }
}

/**
 * The library as lists of media items for Android Auto and the session. IDs:
 * `root`, `artists`, `albums`, `genres`, `songs`, `artist:<key>`, `album:<key>`, `genre:<key>`, and playable
 * `play:<list>:<list key>:<song id>` (the song and the list it was chosen from), or `track:<song id>`.
 */
object Browse {
    const val ROOT = "root"

    private fun enc(text: String): String = Uri.encode(text)
    private fun dec(text: String): String = Uri.decode(text)

    fun folder(id: String, title: String, subtitle: String? = null, art: Uri? = null, extras: Bundle? = null, type: Int = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED): MediaItem =
        MediaItem.Builder()
            .setMediaId(id)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setArtworkUri(art)
                    .setIsBrowsable(true)
                    .setIsPlayable(false)
                    .setMediaType(type)
                    .setExtras(extras)
                    .build(),
            )
            .build()

    private fun grid() = Bundle().apply { putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM) }

    fun playable(context: Context, track: Track, list: String = "track", listKey: String = ""): MediaItem {
        val id = if (list == "track") "track:${track.id}" else "play:$list:${enc(listKey)}:${track.id}"
        return MediaItem.Builder()
            .setMediaId(id)
            .setUri(track.uri)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(track.title)
                    .setArtist(listOfNotNull(track.artist, track.album).distinct().joinToString(" · ").ifEmpty { null })
                    .setAlbumTitle(track.album)
                    .setAlbumArtist(track.albumArtist)
                    .setGenre(track.genre)
                    .setRecordingYear(track.year)
                    .setTrackNumber(track.trackNumber)
                    .setDiscNumber(track.disc)
                    .setDurationMs(track.durationMs)
                    .setArtworkUri(ArtProvider.uri(track.id, 512))
                    .setIsBrowsable(false)
                    .setIsPlayable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                    .build(),
            )
            .build()
    }

    private fun albumItem(album: Album): MediaItem =
        folder("album:${enc(album.key)}", album.title, listOfNotNull(album.artist, album.year?.toString()).joinToString(" · "), ArtProvider.uri(album.tracks.first().id, 320), type = MediaMetadata.MEDIA_TYPE_ALBUM)

    fun children(context: Context, library: Library, parentId: String): List<MediaItem>? {
        val (kind, key) = parentId.split(':', limit = 2).let { it[0] to it.getOrNull(1)?.let(::dec) }
        return when (kind) {
            ROOT -> listOf(
                folder("artists", context.getString(R.string.tab_artists)),
                folder("albums", context.getString(R.string.tab_albums), extras = grid()),
                folder("genres", context.getString(R.string.tab_genres)),
                folder("songs", context.getString(R.string.tab_songs)),
            )
            "artists" -> library.artists.map { artist ->
                folder("artist:${enc(artist.key)}", artist.name, "${artist.albums.size} album${if (artist.albums.size == 1) "" else "s"}", ArtProvider.uri(artist.tracks.first().id, 320), grid(), MediaMetadata.MEDIA_TYPE_ARTIST)
            }
            "albums" -> library.albums.map(::albumItem)
            "genres" -> library.genres.map { genre ->
                folder("genre:${enc(genre.key)}", genre.name, "${genre.albums.size} album${if (genre.albums.size == 1) "" else "s"}", ArtProvider.uri(genre.tracks.first().id, 320), grid(), MediaMetadata.MEDIA_TYPE_GENRE)
            }
            // Android Auto shows at most four tabs, so Favorites sits at the top of Songs.
            "songs" -> listOf(shuffleAll(context, library), folder("favorites", "Favorites", "${favoriteSongs(context, library).size} songs", type = MediaMetadata.MEDIA_TYPE_PLAYLIST)) + library.songs.map { playable(context, it, "songs") }
            "favorites" -> favoriteSongs(context, library).map { playable(context, it, "favorites") }
            "artist" -> library.artistsByKey[key]?.let { actions("artist", key!!, it.tracks.size) + it.albums.map(::albumItem) }
            "album" -> library.albumsByKey[key]?.let { actions("album", key!!, it.tracks.size) + it.tracks.map { t -> playable(context, t, "album", key) } }
            "genre" -> library.genresByKey[key]?.let { actions("genre", key!!, it.tracks.size) + it.albums.map(::albumItem) }
            else -> null
        }
    }

    /** Queue choices at the top of an artist, album or genre in the car: replace the queue, shuffle it, or add to its end. */
    private fun actions(list: String, key: String, count: Int): List<MediaItem> =
        listOf("play" to "Play all", "shuffle" to "Shuffle all", "add" to "Add all to queue").map { (what, title) ->
            MediaItem.Builder()
                .setMediaId("act:$what:$list:${enc(key)}")
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(title)
                        .setSubtitle("$count songs")
                        .setIsBrowsable(false)
                        .setIsPlayable(true)
                        .setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST)
                        .build(),
                )
                .build()
        }

    /** A queue choice from [actions]: what to do ("play", "shuffle", "add") and the songs it covers. */
    fun action(library: Library, mediaId: String): Pair<String, List<Track>>? {
        if (!mediaId.startsWith("act:")) return null
        val parts = mediaId.split(':')
        if (parts.size != 4) return null
        val key = dec(parts[3])
        val tracks = when (parts[2]) {
            "album" -> library.albumsByKey[key]?.tracks
            "artist" -> library.artistsByKey[key]?.tracks
            "genre" -> library.genresByKey[key]?.tracks
            else -> null
        } ?: return null
        return parts[1] to tracks
    }

    private fun favoriteSongs(context: Context, library: Library): List<Track> {
        val ids = Favorites.all(context)
        return library.songs.filter { it.id.toString() in ids }
    }

    private fun shuffleAll(context: Context, library: Library): MediaItem =
        MediaItem.Builder()
            .setMediaId("shuffle:all")
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(context.getString(R.string.shuffle_all))
                    .setSubtitle("${library.songs.size} songs")
                    .setIsBrowsable(false)
                    .setIsPlayable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST)
                    .build(),
            )
            .build()

    fun item(context: Context, library: Library, mediaId: String): MediaItem? {
        resolve(context, library, mediaId)?.let { return it }
        val (kind, key) = mediaId.split(':', limit = 2).let { it[0] to it.getOrNull(1)?.let(::dec) }
        return when (kind) {
            "act" -> {
                val parts = mediaId.split(':')
                if (parts.size == 4) children(context, library, "${parts[2]}:${parts[3]}")?.firstOrNull { it.mediaId == mediaId } else null
            }
            "favorites" -> folder("favorites", "Favorites", type = MediaMetadata.MEDIA_TYPE_PLAYLIST)
            ROOT, "artists", "albums", "genres", "songs" ->children(context, library, ROOT)?.firstOrNull { it.mediaId == mediaId } ?: folder(ROOT, context.getString(R.string.app_name))
            "album" -> library.albumsByKey[key]?.let(::albumItem)
            "artist" -> library.artistsByKey[key]?.let { folder(mediaId, it.name, type = MediaMetadata.MEDIA_TYPE_ARTIST) }
            "genre" -> library.genresByKey[key]?.let { folder(mediaId, it.name, type = MediaMetadata.MEDIA_TYPE_GENRE) }
            else -> null
        }
    }

    /** One playable song from its ID. */
    fun resolve(context: Context, library: Library, mediaId: String): MediaItem? {
        val trackId = when {
            mediaId.startsWith("track:") -> mediaId.removePrefix("track:").toLongOrNull()
            mediaId.startsWith("play:") -> mediaId.substringAfterLast(':').toLongOrNull()
            else -> null
        } ?: return null
        val track = library.byId[trackId] ?: return null
        return playable(context, track)
    }

    /** A song chosen from a list becomes that whole list, starting at the song; "Shuffle all" every song, shuffled. */
    fun expand(context: Context, library: Library, mediaId: String): Pair<List<MediaItem>, Int>? {
        if (mediaId == "shuffle:all") {
            val songs = library.songs.shuffled()
            return songs.map { playable(context, it) } to 0
        }
        if (!mediaId.startsWith("play:")) return null
        val parts = mediaId.split(':')
        if (parts.size != 4) return null
        val list = parts[1]
        val key = dec(parts[2])
        val trackId = parts[3].toLongOrNull() ?: return null
        val tracks = when (list) {
            "album" -> library.albumsByKey[key]?.tracks
            "artist" -> library.artistsByKey[key]?.tracks
            "genre" -> library.genresByKey[key]?.tracks
            "songs" -> library.songs
            "favorites" -> favoriteSongs(context, library)
            "search" -> library.search(key)
            else -> null
        } ?: return null
        val index = tracks.indexOfFirst { it.id == trackId }.coerceAtLeast(0)
        return tracks.map { playable(context, it) } to index
    }
}

/** The queue and place, kept between runs (song IDs only). */
object Resume {
    private const val PREFS = "resume"

    data class State(val items: List<MediaItem>, val index: Int, val positionMs: Long, val shuffle: Boolean, val repeat: Int)

    fun save(context: Context, player: Player) {
        val ids = (0 until player.mediaItemCount).mapNotNull { i -> Browse.idOf(player.getMediaItemAt(i).mediaId) }
        context.getSharedPreferences(Profiles.file(context, PREFS), Context.MODE_PRIVATE).edit()
            .putString("ids", ids.joinToString(","))
            .putInt("index", player.currentMediaItemIndex)
            .putLong("position", player.currentPosition.coerceAtLeast(0))
            .putBoolean("shuffle", player.shuffleModeEnabled)
            .putInt("repeat", player.repeatMode)
            .apply()
    }

    /** The queue remembered for a profile (the current one unless said). */
    fun load(context: Context, library: Library, profile: String = Profiles.current(context), adopted: String? = null): State? {
        val file = if (adopted != null && profile.equals(adopted, ignoreCase = true)) PREFS else Profiles.file(context, PREFS, profile)
        val prefs = context.getSharedPreferences(file, Context.MODE_PRIVATE)
        val ids = prefs.getString("ids", "").orEmpty().split(',').mapNotNull { it.toLongOrNull() }
        val items = ids.mapNotNull { library.byId[it] }.map { Browse.playable(context, it) }
        if (items.isEmpty()) return null
        return State(items, prefs.getInt("index", 0).coerceIn(0, items.size - 1), prefs.getLong("position", 0), prefs.getBoolean("shuffle", false), prefs.getInt("repeat", Player.REPEAT_MODE_OFF))
    }
}

/** The song ID inside any playable media ID. */
fun Browse.idOf(mediaId: String): Long? = when {
    mediaId.startsWith("track:") -> mediaId.removePrefix("track:").toLongOrNull()
    mediaId.startsWith("play:") -> mediaId.substringAfterLast(':').toLongOrNull()
    else -> null
}
