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
 * a server on the home network into the phone's Music folder ("Music/Artist/Album/", D207), through the media index so Android knows the song at once, and
 * takes songs off again. It only ever deletes songs it put there (Android records which app created a file), never the person's other music.
 */
object HomeSync {
    /** The folder under the phone's storage that fetched music goes into: the Music folder itself (owner, 2026-11-26). */
    const val ROOT = "Music"
    /** Where earlier versions put it; what is there is moved up into [ROOT]. */
    const val OLD_ROOT = "Music/MediaVerse Home"
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

    /** Whether a song is one this app fetched: Android says this app created it, or it is still in the old download folder. */
    fun ownedByApp(owner: String?, folder: String?, packageName: String): Boolean = owner == packageName || folder?.startsWith("$OLD_ROOT/") == true

    private fun isOurs(context: Context, id: Long): Boolean {
        val columns = arrayOf(MediaStore.MediaColumns.OWNER_PACKAGE_NAME, MediaStore.Audio.Media.RELATIVE_PATH)
        val cursor = context.contentResolver.query(uriOf(id), columns, null, null, null) ?: return false
        cursor.use { c -> return c.moveToFirst() && ownedByApp(c.getString(0), c.getString(1), context.packageName) }
    }

    /** Where a folder of the old download folder belongs now ("Music/MediaVerse Home/Band/Record/" is "Music/Band/Record/"), or null when it is not one. */
    fun movedFolder(folder: String): String? = if (folder.startsWith("$OLD_ROOT/")) "$ROOT/" + folder.removePrefix("$OLD_ROOT/") else null

    /** The names to try for a song whose own name is taken in the folder it moves to. */
    fun spareNames(name: String): List<String> {
        val dot = name.lastIndexOf('.')
        val (stem, end) = if (dot > 0) name.substring(0, dot) to name.substring(dot) else name to ""
        return listOf(name) + (2..9).map { "$stem ($it)$end" }
    }

    /**
     * Moves what earlier versions fetched into "Music/MediaVerse Home" up into the Music folder. Each song keeps its media id, so hearts,
     * flags, play counts and playlists stay with it. Nothing is deleted; folders left empty are removed. Answers
     * `{type: "movedToRoot", id, moved, failed, needPermission: [ids Android wants the person's permission for]}`.
     */
    fun moveToRoot(context: Context, id: String, progress: (done: Int, total: Int) -> Unit): JSONObject {
        val found = ArrayList<Triple<Long, String, String>>()
        try {
            context.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.RELATIVE_PATH, MediaStore.Audio.Media.DISPLAY_NAME),
                "${MediaStore.Audio.Media.RELATIVE_PATH} LIKE ?", arrayOf("$OLD_ROOT/%"), null,
            )?.use { c -> while (c.moveToNext()) found += Triple(c.getLong(0), c.getString(1) ?: "", c.getString(2) ?: "") }
        } catch (_: SecurityException) {
            // no permission to read music yet: there is nothing this app can move
        }
        var moved = 0
        var failed = 0
        val needPermission = JSONArray()
        for ((index, song) in found.withIndex()) {
            val (songId, folder, name) = song
            val target = movedFolder(folder) ?: continue
            if (index % 10 == 0) progress(index, found.size)
            var done = false
            for (candidate in spareNames(name)) {
                // A file already there keeps its name; the moved song takes the next free one.
                if (java.io.File(android.os.Environment.getExternalStorageDirectory(), "$target$candidate").exists()) continue
                try {
                    val values = ContentValues().apply {
                        put(MediaStore.Audio.Media.RELATIVE_PATH, target)
                        put(MediaStore.Audio.Media.DISPLAY_NAME, candidate)
                    }
                    done = context.contentResolver.update(uriOf(songId), values, null, null) > 0
                } catch (_: SecurityException) {
                    needPermission.put(songId.toString())
                } catch (_: Exception) {
                    // counted below
                }
                break
            }
            if (done) moved++ else failed++
        }
        removeEmptyFolders(java.io.File(android.os.Environment.getExternalStorageDirectory(), OLD_ROOT))
        return JSONObject().put("type", "movedToRoot").put("id", id).put("moved", moved).put("failed", failed).put("needPermission", needPermission)
    }

    /** Removes a folder and the folders in it that hold nothing (a folder with any file in it stays). */
    private fun removeEmptyFolders(folder: java.io.File) {
        if (!folder.isDirectory) return
        folder.listFiles()?.forEach { removeEmptyFolders(it) }
        if (folder.list()?.isEmpty() == true) folder.delete()
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
                    ArtProvider.forget(context, target) // the song keeps its id, so its remembered cover would be the old one
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

    /**
     * Sends one song on the phone to the computer (D214) or the Jellyfin server's plugin (D215): `{id, url, headers, mediaId}`. The file is streamed, never held
     * in memory, and only to an address on the home network. Answers `{type: "uploaded", id, ok, already | error}`.
     */
    fun upload(context: Context, message: JSONObject, progress: (bytes: Long, total: Long) -> Unit): JSONObject {
        val id = message.optString("id")
        fun fail(text: String) = JSONObject().put("type", "uploaded").put("id", id).put("ok", false).put("error", text)
        val media = message.optString("mediaId").toLongOrNull() ?: return fail("That song is not on the phone.")
        return try {
            val url = URL(message.optString("url"))
            if (url.protocol != "http" && url.protocol != "https") return fail("Only http and https addresses are used.")
            if (InetAddress.getAllByName(url.host).none { HomeHttp.isHomeAddress(it) }) return fail("Only a computer or server on the home network can be used.")
            val uri = uriOf(media)
            val total = context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: return fail("The song cannot be read.")
            if (total <= 0) return fail("The song is empty.")
            val connection = url.openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 15_000
                connection.readTimeout = 120_000
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(total)
                message.optJSONObject("headers")?.let { h -> h.keys().forEach { connection.setRequestProperty(it, h.optString(it)) } }
                connection.setRequestProperty("Content-Type", "application/octet-stream")
                context.contentResolver.openInputStream(uri)?.use { input ->
                    connection.outputStream.use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var done = 0L
                        var lastReport = 0L
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
                } ?: return fail("The song cannot be read.")
                val status = connection.responseCode
                if (status == 401) return fail("This phone's sign-in is no longer accepted. Pair or sign in again.")
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                val answer = runCatching { JSONObject(stream?.use { it.readNBytes(4096).toString(Charsets.UTF_8) } ?: "") }.getOrNull()
                // (Jellyfin writes its answers' names with a capital, the computer without.)
                if (status != 200) return fail(listOf("message", "Message").firstNotNullOfOrNull { answer?.optString(it)?.ifEmpty { null } } ?: "The answer was $status.")
                JSONObject().put("type", "uploaded").put("id", id).put("ok", true).put("already", answer?.optBoolean("already") == true || answer?.optBoolean("Already") == true)
            } finally {
                connection.disconnect()
            }
        } catch (e: Exception) {
            fail(e.message ?: "There was no answer.")
        }
    }

    /** Takes songs fetched from the server off the phone: `ids` are media-index ids; answers the ones that went. A song this app did not create is refused. */
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
