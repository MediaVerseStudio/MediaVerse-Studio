package studio.mediaverse.app

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer

/** One song on the phone, as Android's media index (MediaStore) describes it. */
data class Track(
    val id: Long,
    val title: String,
    val artist: String?,
    val album: String?,
    val albumArtist: String?,
    val genre: String?,
    val year: Int?,
    val trackNumber: Int?,
    val disc: Int?,
    val durationMs: Long,
    /** The song's folder relative to its storage ("Music/Orbital/In Sides/"): one album per folder, as on the TV. */
    val folderPath: String,
    /** When Android first saw the file (seconds since 1970), for "Recently added". */
    val added: Long = 0,
    /** The file's name and size in bytes: music already on the phone is recognised by them when it is kept in step with a home server (D178). */
    val file: String = "",
    val size: Long = 0,
) {
    val uri: Uri get() = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)
    val folder: String get() = folderPath.trimEnd('/').substringAfterLast('/')
}

data class Album(val key: String, val title: String, val artist: String, val year: Int?, val tracks: List<Track>)
data class Artist(val key: String, val name: String, val albums: List<Album>, val tracks: List<Track>)
data class Genre(val key: String, val name: String, val albums: List<Album>, val tracks: List<Track>)

/**
 * The music on the phone, grouped the way the TV app groups the computer's library (web/app/tv/library.ts):
 * an album per folder, artists by each song's own artist, genres split on ";" "/" ",". Read from MediaStore,
 * which Android keeps up to date as files are copied onto the phone. Pure grouping lives in [Grouping] so it is
 * unit tested without a phone.
 */
class Library(val tracks: List<Track>) {
    val byId: Map<Long, Track> = tracks.associateBy { it.id }
    val albums: List<Album> = Grouping.albums(tracks)
    val albumsByKey: Map<String, Album> = albums.associateBy { it.key }
    val albumOf: Map<Long, Album> = albums.flatMap { album -> album.tracks.map { it.id to album } }.toMap()
    val artists: List<Artist> = Grouping.artists(albums)
    val artistsByKey: Map<String, Artist> = artists.associateBy { it.key }
    val genres: List<Genre> = Grouping.genres(albums)
    val genresByKey: Map<String, Genre> = genres.associateBy { it.key }
    /** Every song in album order (artist, year, album, track). */
    val songs: List<Track> = albums.flatMap { it.tracks }

    /** The library as the web page wants it: the TV app's ServerTrack shape plus the length. */
    fun toJson(): JSONArray {
        val list = JSONArray()
        for (track in songs) {
            list.put(
                JSONObject()
                    .put("id", track.id.toString())
                    .put("title", track.title)
                    .put("artist", track.artist ?: JSONObject.NULL)
                    .put("album", track.album ?: JSONObject.NULL)
                    .put("album_artist", track.albumArtist ?: JSONObject.NULL)
                    .put("genre", track.genre ?: JSONObject.NULL)
                    .put("year", track.year ?: JSONObject.NULL)
                    .put("track_number", track.trackNumber ?: JSONObject.NULL)
                    .put("disc", track.disc ?: JSONObject.NULL)
                    .put("cover_key", track.folderPath)
                    .put("folder", track.folder)
                    .put("duration_ms", track.durationMs)
                    .put("added", track.added)
                    .put("file", track.file)
                    .put("size", track.size),
            )
        }
        return list
    }

    /** Songs, albums and artists whose names hold every word asked for (Android Auto's voice and search). */
    fun search(query: String, limit: Int = 50): List<Track> {
        val wanted = Grouping.words(query)
        if (wanted.isEmpty()) return emptyList()
        fun matches(text: String) = Grouping.words(text).let { have -> wanted.all { w -> have.any { it.contains(w) } } }
        val artist = artists.firstOrNull { matches(it.name) }
        if (artist != null && wanted.size <= Grouping.words(artist.name).size) return artist.tracks.take(500)
        val album = albums.firstOrNull { matches("${it.title} ${it.artist}") }
        if (album != null) return album.tracks
        return songs.filter { matches("${it.title} ${it.artist ?: ""}") }.take(limit)
    }

    companion object {
        @Volatile
        private var cached: Library? = null

        /** The library, read once and kept; [reload] reads it again (after music was added). */
        fun get(context: Context): Library = cached ?: reload(context)

        @Synchronized
        fun reload(context: Context): Library {
            val library = Library(readMediaStore(context))
            cached = library
            return library
        }

        private fun readMediaStore(context: Context): List<Track> {
            val columns = arrayOf(
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.ALBUM_ARTIST,
                MediaStore.Audio.Media.GENRE,
                MediaStore.Audio.Media.YEAR,
                MediaStore.Audio.Media.TRACK,
                MediaStore.Audio.Media.CD_TRACK_NUMBER,
                MediaStore.Audio.Media.DISC_NUMBER,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.RELATIVE_PATH,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.DATE_ADDED,
                MediaStore.Audio.Media.SIZE,
            )
            val tracks = ArrayList<Track>()
            val cursor = try {
                context.contentResolver.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, columns, "${MediaStore.Audio.Media.IS_MUSIC} != 0", null, null)
            } catch (_: SecurityException) {
                null // no permission yet
            } ?: return tracks
            cursor.use { c ->
                fun text(i: Int): String? = if (c.isNull(i)) null else c.getString(i)?.trim()?.takeIf { it.isNotEmpty() && it != "<unknown>" }
                while (c.moveToNext()) {
                    val name = text(12) ?: ""
                    // macOS "AppleDouble" files ("._01 Song.mp3") and __MACOSX folders from zip files are not songs
                    // (owner, 2026-11-05: on the PC they showed up as "Unknown album").
                    if (Grouping.isSystemClutter(name, text(11) ?: "")) continue
                    val legacyTrack = if (c.isNull(7)) null else c.getInt(7)
                    tracks += Track(
                        id = c.getLong(0),
                        title = text(1) ?: name.substringBeforeLast('.'),
                        artist = text(2),
                        album = text(3),
                        albumArtist = text(4),
                        genre = text(5),
                        year = if (c.isNull(6)) null else c.getInt(6).takeIf { it > 0 },
                        trackNumber = Grouping.number(text(8)) ?: legacyTrack?.let { it % 1000 }?.takeIf { it > 0 },
                        disc = Grouping.number(text(9)) ?: legacyTrack?.let { it / 1000 }?.takeIf { it > 0 },
                        durationMs = c.getLong(10),
                        folderPath = text(11) ?: "",
                        added = if (c.isNull(13)) 0 else c.getLong(13),
                        file = name,
                        size = if (c.isNull(14)) 0 else c.getLong(14),
                    )
                }
            }
            return tracks
        }
    }
}

/** The TV app's grouping rules, without Android, so they can be unit tested. */
object Grouping {
    private const val MIN_ALBUM_IN_FOLDER = 3
    const val UNKNOWN_ARTIST = "Unknown artist"
    const val UNKNOWN_ALBUM = "Unknown album"

    /** "3", "3/12" or "03" as 3. */
    fun number(text: String?): Int? = text?.substringBefore('/')?.trim()?.toIntOrNull()?.takeIf { it > 0 }

    /** macOS AppleDouble files ("._01 Song.mp3") and anything in a __MACOSX folder: not music, whatever the name. */
    fun isSystemClutter(fileName: String, folderPath: String): Boolean =
        fileName.startsWith("._") || folderPath.split('/').any { it.equals("__MACOSX", ignoreCase = true) }

    /** Ignores case, accents and a leading "The ". */
    fun sortKey(text: String): String =
        Normalizer.normalize(text, Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "").lowercase().replace(Regex("^the\\s+"), "").trim()

    fun words(text: String): List<String> = sortKey(text).split(Regex("[^a-z0-9]+")).filter { it.isNotEmpty() }

    private val byName = Comparator<String> { a, b -> sortKey(a).compareTo(sortKey(b)) }

    private fun mostCommon(values: List<String?>): Pair<String, Int>? {
        val counts = LinkedHashMap<String, Pair<String, Int>>()
        for (raw in values) {
            val value = raw?.trim().orEmpty()
            if (value.isEmpty()) continue
            val key = value.lowercase()
            counts[key] = (counts[key]?.first ?: value) to ((counts[key]?.second ?: 0) + 1)
        }
        return counts.values.maxByOrNull { it.second }
    }

    private fun albumArtist(tracks: List<Track>): String {
        tracks.firstNotNullOfOrNull { it.albumArtist?.trim()?.takeIf(String::isNotEmpty) }?.let { return it }
        val counts = LinkedHashMap<String, Int>()
        for (t in tracks) t.artist?.trim()?.takeIf(String::isNotEmpty)?.let { counts[it] = (counts[it] ?: 0) + 1 }
        val best = counts.maxByOrNull { it.value } ?: return UNKNOWN_ARTIST
        if (counts.size > 1 && best.value * 2 <= tracks.size) return "Various artists"
        return best.key
    }

    private val trackOrder = compareBy<Track>({ it.disc ?: 1 }, { it.trackNumber ?: Int.MAX_VALUE }, { sortKey(it.title) })

    fun albums(tracks: List<Track>): List<Album> {
        val groups = ArrayList<Pair<String, List<Track>>>()
        for ((folder, inFolder) in tracks.groupBy { it.folderPath }) {
            val parts = inFolder.groupBy { (it.album ?: "").trim().lowercase() }
            if (parts.size > 1 && parts.values.all { it.size >= MIN_ALBUM_IN_FOLDER }) {
                for ((name, group) in parts) groups += "$folder\u0000$name" to group
            } else {
                groups += folder to inFolder
            }
        }
        return groups.map { (key, group) ->
            val sorted = group.sortedWith(trackOrder)
            val common = mostCommon(sorted.map { it.album })
            val folderName = sorted.first().folder.trim()
            val title = if (common != null && (common.second * 2 > sorted.size || folderName.isEmpty())) common.first else folderName.ifEmpty { UNKNOWN_ALBUM }
            Album(key, title, albumArtist(sorted), sorted.firstNotNullOfOrNull { it.year }, sorted)
        }.sortedWith(compareBy<Album, String>(byName) { it.artist }.thenBy { it.year ?: 9999 }.thenBy(byName) { it.title })
    }

    /** A credit without its guests ("Band feat. Singer" is "Band"); "&", "and" and "with" stay (band names). */
    fun withoutFeatured(credit: String): String {
        val cut = credit.replace(Regex("\\s*[(\\[]\\s*(feat\\.?|ft\\.?|featuring)\\s[^)\\]]*[)\\]]\\s*$", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\s+(feat\\.?|ft\\.?|featuring)\\s.*$", RegexOption.IGNORE_CASE), "")
        return cut.trim().ifEmpty { credit.trim() }
    }

    /** Whom a song is listed under on the artists page, as on the TV (web/app/tv/library.ts listedArtist): the
     *  album artist on an ordinary album; on a Various Artists compilation the song's own artist without guests. */
    fun listedArtist(track: Track): String {
        val albumArtist = track.albumArtist?.trim()?.takeIf(String::isNotEmpty)
        if (albumArtist != null && !Regex("^(various( artists)?|va)$", RegexOption.IGNORE_CASE).matches(albumArtist)) return albumArtist
        return track.artist?.trim()?.takeIf(String::isNotEmpty)?.let(::withoutFeatured) ?: albumArtist ?: UNKNOWN_ARTIST
    }

    /** Whom a song is filed under on the artists list: null on a Various Artists compilation (owner, 2026-11-10: such
     *  bands are guests there, found by search, not listed; same rule as web/app/tv/library.ts filedArtist). */
    fun filedArtist(track: Track): String? {
        val albumArtist = track.albumArtist?.trim()?.takeIf(String::isNotEmpty)
        return if (albumArtist != null && Regex("^(various( artists)?|va)$", RegexOption.IGNORE_CASE).matches(albumArtist)) null else listedArtist(track)
    }

    fun artists(albums: List<Album>): List<Artist> {
        data class Building(val name: String, val albums: MutableList<Album> = ArrayList(), val tracks: MutableList<Track> = ArrayList())
        val byKey = LinkedHashMap<String, Building>()
        for (album in albums) {
            for (track in album.tracks) {
                val name = filedArtist(track) ?: continue
                val artist = byKey.getOrPut(sortKey(name)) { Building(name) }
                if (artist.albums.lastOrNull() !== album) artist.albums += album
                artist.tracks += track
            }
        }
        return byKey.map { (key, b) -> Artist(key, b.name, b.albums, b.tracks) }.sortedWith(compareBy(byName) { it.name })
    }

    fun genres(albums: List<Album>): List<Genre> {
        data class Building(val names: LinkedHashMap<String, Int> = LinkedHashMap(), val tracks: MutableList<Track> = ArrayList(), val albums: LinkedHashSet<Album> = LinkedHashSet())
        val byKey = LinkedHashMap<String, Building>()
        val split = Regex("\\s*[;/,|]\\s*|\u0000")
        val numeric = Regex("^\\(?\\d+\\)?$")
        for (album in albums) {
            for (track in album.tracks) {
                val parts = (track.genre ?: "").split(split).map { it.trim() }.filter { it.isNotEmpty() && !numeric.matches(it) }.toSet()
                for (name in parts) {
                    val key = sortKey(name).replace(Regex("[\\s-]+"), " ")
                    val genre = byKey.getOrPut(key) { Building() }
                    genre.names[name] = (genre.names[name] ?: 0) + 1
                    genre.tracks += track
                    genre.albums += album
                }
            }
        }
        return byKey.map { (key, b) -> Genre(key, b.names.maxBy { it.value }.key, b.albums.toList(), b.tracks) }.sortedWith(compareBy(byName) { it.name })
    }
}
