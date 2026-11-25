package studio.mediaverse.app

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL

/**
 * Keeping chosen music on the phone in step with the home Jellyfin server (D177). The page decides what to keep and asks for each song here: this fetches one song from
 * a server on the home network into the phone's Music folder (under "Music/MediaVerse Home/Artist/Album/"), through the media index so Android knows the song at once, and
 * takes songs off again. It only ever deletes songs it put there (checked by folder), never the person's other music.
 */
object HomeSync {
    /** The folder under the phone's storage that holds what was fetched from the server. */
    const val ROOT = "Music/MediaVerse Home"
    private val EXTENSIONS = setOf("mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "wma", "wv")

    /** Whether the phone is on Wi-Fi now, and whether that connection is metered (a phone's own hotspot, say). */
    fun network(context: Context): JSONObject {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        val capabilities = manager?.activeNetwork?.let { manager.getNetworkCapabilities(it) }
        return JSONObject()
            .put("type", "network")
            .put("wifi", capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true || capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true)
            .put("metered", capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) != true)
    }

    /** The folder names and the file name of a path from the page ("Artist/Album/01 - Song.mp3"), or null when it is not a plain relative path to a song. */
    fun cleanPath(path: String): List<String>? {
        val parts = path.split('/')
        if (parts.size < 2 || parts.size > 6) return null
        for (part in parts) {
            if (part.isEmpty() || part == "." || part == ".." || part.length > 120) return null
            if (part.any { it == '\\' || it == ':' || it == '<' || it == '>' || it == '"' || it == '|' || it == '?' || it == '*' || it.code < 32 }) return null
        }
        val extension = parts.last().substringAfterLast('.', "").lowercase()
        return if (extension in EXTENSIONS) parts else null
    }

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.').lowercase()) {
        "mp3" -> "audio/mpeg"
        "flac" -> "audio/flac"
        "m4a" -> "audio/mp4"
        "aac" -> "audio/aac"
        "ogg", "opus" -> "audio/ogg"
        "wav" -> "audio/wav"
        "wma" -> "audio/x-ms-wma"
        else -> "audio/x-wavpack"
    }

    private fun uriOf(id: Long) = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)

    /** The media-index addresses for a permission request to update songs in place. */
    fun uris(ids: List<String>): List<android.net.Uri> = ids.mapNotNull { it.toLongOrNull() }.map { uriOf(it) }

    /** How much of a song is compared to tell whether two copies are the same file: the first 64 KB (the tags and the start of the sound) and up to 8 KB at the end (an old-style tag). */
    const val HEAD = 65_536
    const val TAIL = 8_192

    /** The bytes a fingerprint covers, as (offset, length) pieces of a file of `size` bytes. */
    fun fingerprintPieces(size: Long): List<Pair<Long, Int>> {
        if (size <= 0) return emptyList()
        val head = minOf(size, HEAD.toLong()).toInt()
        val tail = minOf(TAIL.toLong(), size - head).toInt()
        return if (tail > 0) listOf(0L to head, size - tail to tail) else listOf(0L to head)
    }

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    /**
     * Whether the copy of a song on the phone (`localId`) is the same file as the server's (`url`, of `size` bytes): compares a fingerprint of the head and tail of both
     * (the server sends only those pieces, by byte range), so two copies that have the same size but were edited (a tag changed, padding kept) are told apart without
     * fetching the whole song. Answers `{type: "fingerprint", id, same | null, error?}`; null when it could not be checked.
     */
    fun fingerprint(context: Context, message: JSONObject): JSONObject {
        val id = message.optString("id")
        fun answer(same: Boolean?, error: String? = null) = JSONObject().put("type", "fingerprint").put("id", id).put("same", same ?: JSONObject.NULL).apply { if (error != null) put("error", error) }
        return try {
            val size = message.optLong("size")
            val local = message.optString("localId").toLongOrNull() ?: return answer(null, "no song")
            val pieces = fingerprintPieces(size)
            if (pieces.isEmpty()) return answer(null, "empty")
            val url = URL(message.optString("url"))
            if (url.protocol != "http" && url.protocol != "https") return answer(null, "bad address")
            if (InetAddress.getAllByName(url.host).none { HomeHttp.isHomeAddress(it) }) return answer(null, "not on the home network")
            val mine = java.security.MessageDigest.getInstance("SHA-256")
            val theirs = java.security.MessageDigest.getInstance("SHA-256")
            context.contentResolver.openFileDescriptor(uriOf(local), "r")?.use { pfd ->
                java.io.FileInputStream(pfd.fileDescriptor).channel.use { channel ->
                    if (channel.size() != size) return answer(false)
                    for ((offset, length) in pieces) {
                        val buffer = java.nio.ByteBuffer.allocate(length)
                        channel.position(offset)
                        while (buffer.hasRemaining() && channel.read(buffer) >= 0) { /* fill */ }
                        mine.update(buffer.array(), 0, buffer.position())
                    }
                }
            } ?: return answer(null, "cannot read")
            for ((offset, length) in pieces) {
                val connection = url.openConnection() as HttpURLConnection
                try {
                    connection.connectTimeout = 15_000
                    connection.readTimeout = 30_000
                    message.optJSONObject("headers")?.let { h -> h.keys().forEach { connection.setRequestProperty(it, h.optString(it)) } }
                    connection.setRequestProperty("Range", "bytes=$offset-${offset + length - 1}")
                    val status = connection.responseCode
                    if (status != 206 && status != 200) return answer(null, "the server answered $status")
                    connection.inputStream.use { input ->
                        if (status == 200) input.skipNBytes(offset) // a server that ignores ranges: read on to the piece
                        val bytes = input.readNBytes(length)
                        if (bytes.size != length) return answer(null, "the server sent too little")
                        theirs.update(bytes)
                    }
                } finally {
                    connection.disconnect()
                }
            }
            answer(hex(mine.digest()) == hex(theirs.digest()))
        } catch (e: Exception) {
            answer(null, e.message ?: "not checked")
        }
    }

    /** Whether a media-index row is a song this app fetched (its folder is under [ROOT]). */
    private fun isOurs(context: Context, id: Long): Boolean {
        val cursor = context.contentResolver.query(uriOf(id), arrayOf(MediaStore.Audio.Media.RELATIVE_PATH), null, null, null) ?: return false
        cursor.use { c -> return c.moveToFirst() && c.getString(0)?.startsWith("$ROOT/") == true }
    }

    /**
     * Fetches one song: `{id, url, headers, path, replace?}`. The song is read into a temporary file first, so a failure part-way leaves the phone's copy untouched; then the
     * old copy (`replace`, a media-index id) goes and the new one is written into the Music folder. Answers `{type: "downloaded", id, ok, mediaId, bytes | error}`.
     */
    fun download(context: Context, message: JSONObject, progress: (bytes: Long, total: Long) -> Unit): JSONObject {
        val id = message.optString("id")
        fun fail(text: String) = JSONObject().put("type", "downloaded").put("id", id).put("ok", false).put("error", text)
        val parts = cleanPath(message.optString("path")) ?: return fail("That is not a safe place to put a song.")
        val temp = File(context.cacheDir, "download-${id.filter { it.isLetterOrDigit() }.take(40)}.part")
        try {
            val url = URL(message.optString("url"))
            if (url.protocol != "http" && url.protocol != "https") return fail("Only http and https addresses are used.")
            if (InetAddress.getAllByName(url.host).none { HomeHttp.isHomeAddress(it) }) return fail("Only a server on the home network can be used.")
            val connection = url.openConnection() as HttpURLConnection
            val total: Long
            try {
                connection.connectTimeout = 15_000
                connection.readTimeout = 30_000
                message.optJSONObject("headers")?.let { h -> h.keys().forEach { connection.setRequestProperty(it, h.optString(it)) } }
                val status = connection.responseCode
                if (status == 401 || status == 403) return fail("The server does not accept this phone any more. Sign in again.")
                if (status != 200) return fail("The server answered $status.")
                total = connection.contentLengthLong
                var done = 0L
                var lastReport = 0L
                connection.inputStream.use { input ->
                    temp.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            output.write(buffer, 0, n)
                            done += n
                            val now = System.currentTimeMillis()
                            if (now - lastReport > 400) {
                                lastReport = now
                                progress(done, total)
                            }
                        }
                    }
                }
                if (total > 0 && done != total) return fail("The song was cut short on the way.")
                if (done == 0L) return fail("The server sent nothing.")
            } finally {
                connection.disconnect()
            }
            // A song the person already had on the phone is updated where it is (so its heart, play count and playlists stay): needs Android's one-time permission for it.
            val inPlace = message.optBoolean("inPlace")
            val target = message.optString("replace").toLongOrNull()
            if (inPlace && target != null) {
                return try {
                    val uri = uriOf(target)
                    context.contentResolver.openOutputStream(uri, "wt")?.use { output -> temp.inputStream().use { it.copyTo(output) } } ?: throw IllegalStateException("No place to write the song.")
                    // (the pending flag is not used here: Android refuses writes to a pending song the app did not create)
                    JSONObject().put("type", "downloaded").put("id", id).put("ok", true).put("mediaId", target.toString()).put("bytes", temp.length())
                } catch (e: SecurityException) {
                    fail("Android needs your permission to update this song.")
                } catch (e: Exception) {
                    fail(e.message ?: "The song could not be updated.")
                }
            }
            // The old copy goes now (a failure above has left it alone), then the new one takes its place.
            val old = target
            if (old != null && isOurs(context, old)) context.contentResolver.delete(uriOf(old), null, null)
            val name = parts.last()
            val values = ContentValues().apply {
                put(MediaStore.Audio.Media.DISPLAY_NAME, name)
                put(MediaStore.Audio.Media.MIME_TYPE, mimeOf(name))
                put(MediaStore.Audio.Media.RELATIVE_PATH, "$ROOT/${parts.dropLast(1).joinToString("/")}")
                put(MediaStore.Audio.Media.IS_PENDING, 1)
            }
            val uri = context.contentResolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values) ?: return fail("Android would not make room for the song.")
            try {
                context.contentResolver.openOutputStream(uri)?.use { output -> temp.inputStream().use { it.copyTo(output) } } ?: throw IllegalStateException("No place to write the song.")
                context.contentResolver.update(uri, ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }, null, null)
            } catch (e: Exception) {
                context.contentResolver.delete(uri, null, null)
                return fail(e.message ?: "The song could not be saved.")
            }
            val newId = ContentUris.parseId(uri)
            if (old != null) {
                // The heart and the play counts follow the song to its new copy.
                Favorites.moved(context, old.toString(), newId.toString())
                PlayStats.moved(context, old, newId)
            }
            return JSONObject().put("type", "downloaded").put("id", id).put("ok", true).put("mediaId", newId.toString()).put("bytes", temp.length())
        } catch (e: Exception) {
            return fail(e.message ?: "The server did not answer.")
        } finally {
            temp.delete()
        }
    }

    /** Takes songs fetched from the server off the phone: `ids` are media-index ids; answers the ones that went. Anything not under [ROOT] is refused. */
    fun delete(context: Context, ids: List<String>): List<String> {
        val gone = ArrayList<String>()
        for (text in ids) {
            val id = text.toLongOrNull() ?: continue
            try {
                if (!isOurs(context, id)) {
                    // Already gone (the person deleted it) counts as taken off; one that is somewhere else is not ours to delete.
                    val exists = context.contentResolver.query(uriOf(id), arrayOf(MediaStore.Audio.Media._ID), null, null, null)?.use { it.moveToFirst() } == true
                    if (!exists) gone += text
                    continue
                }
                if (context.contentResolver.delete(uriOf(id), null, null) > 0) gone += text
            } catch (_: SecurityException) {
                // not ours to delete after all
            }
        }
        return gone
    }

    fun deleted(id: String, ids: List<String>): JSONObject = JSONObject().put("type", "deletedLocal").put("id", id).put("ids", JSONArray(ids))
}
