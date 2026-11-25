package studio.mediaverse.app

import android.content.ContentProvider
import android.content.ContentValues
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import android.util.Size
import java.io.File
import java.io.FileNotFoundException

/**
 * Album covers by song: `content://studio.mediaverse.app.art/track/<id>/<size>`. The notification, the lock screen
 * and Android Auto open covers by address from their own processes, so this is exported; it only ever answers
 * with a JPEG picture of a song's embedded cover, never the music or anything else. Covers are made once per size
 * and kept in the app's cache folder.
 */
class ArtProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String = "image/jpeg"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("Covers are read only.")
        val (id, size) = parse(uri) ?: throw FileNotFoundException("Not a cover address.")
        val file = cover(context ?: throw FileNotFoundException(), id, size) ?: throw FileNotFoundException("This song has no cover.")
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    companion object {
        const val AUTHORITY = "studio.mediaverse.app.art"
        private val SIZES = intArrayOf(96, 192, 320, 512, 800)

        fun uri(trackId: Long, size: Int = 512): Uri = Uri.parse("content://$AUTHORITY/track/$trackId/${fit(size)}")

        /** The nearest kept size at or above `wanted`, so the cache holds a few sizes only. */
        fun fit(wanted: Int): Int = SIZES.firstOrNull { it >= wanted } ?: SIZES.last()

        private fun parse(uri: Uri): Pair<Long, Int>? {
            val parts = uri.pathSegments
            if (uri.authority != AUTHORITY || parts.size != 3 || parts[0] != "track") return null
            val id = parts[1].toLongOrNull() ?: return null
            val size = parts[2].toIntOrNull() ?: return null
            return id to fit(size)
        }

        /** Whether the app may read pictures (the album folder files); asked for after the music permission. */
        fun canReadImages(context: Context): Boolean {
            val permission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
            return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
        }

        /** Forgets the songs found to have no cover, so a newly allowed folder picture gets a chance. */
        fun forgetMissing(context: Context) {
            File(context.cacheDir, "covers").listFiles { f -> f.name.endsWith(".none") }?.forEach { it.delete() }
        }

        private val PICTURE_TYPES = setOf("jpg", "jpeg", "png")
        private val FOLDER_NAMES = listOf("cover", "folder", "front", "albumart", "album", "artwork")

        /** The picture file in an album folder that is its cover: cover, folder, front or albumart; else a name saying cover/front. */
        fun pickFolderPicture(names: List<String>): String? {
            val pictures = names.filter { it.substringAfterLast(".", "").lowercase() in PICTURE_TYPES }
            val bare = { n: String -> n.substringBeforeLast(".").lowercase() }
            FOLDER_NAMES.firstNotNullOfOrNull { wanted -> pictures.firstOrNull { bare(it) == wanted } }?.let { return it }
            return pictures.firstOrNull { n -> bare(n).let { ("cover" in it || "front" in it || "folder" in it) && "back" !in it } }
        }

        /** The album folder's own picture for a song with no embedded cover (owner, 2026-11-10), scaled to fit the size. */
        private fun folderPicture(context: Context, trackId: Long, size: Int): Bitmap? {
            if (!canReadImages(context)) return null
            val audio = android.content.ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, trackId)
            val relative = try {
                context.contentResolver.query(audio, arrayOf(MediaStore.MediaColumns.RELATIVE_PATH), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
            } catch (_: Exception) {
                null
            } ?: return null
            val dir = File(Environment.getExternalStorageDirectory(), relative)
            val name = pickFolderPicture(dir.list()?.toList() ?: return null) ?: return null
            val path = File(dir, name).path
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= size && bounds.outHeight / (sample * 2) >= size) sample *= 2
            val full = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
            val scale = size.toFloat() / maxOf(full.width, full.height)
            if (scale >= 1f) return full
            val scaled = Bitmap.createScaledBitmap(full, (full.width * scale).toInt().coerceAtLeast(1), (full.height * scale).toInt().coerceAtLeast(1), true)
            if (scaled !== full) full.recycle()
            return scaled
        }

        /** A "no cover" answer is only trusted for an hour: a song copied or re-scanned later gets another look. */
        private const val NONE_VALID_MS = 60 * 60 * 1000L

        /** The song's own cover: Android's thumbnail, else the picture read straight from the file's tag, else the album folder. */
        private fun ownCover(context: Context, trackId: Long, size: Int): Bitmap? {
            val audio = android.content.ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, trackId)
            try {
                return context.contentResolver.loadThumbnail(audio, Size(size, size), null)
            } catch (_: Exception) {
            }
            embedded(context, audio, size)?.let { return it }
            return folderPicture(context, trackId, size)
        }

        private fun embedded(context: Context, audio: Uri, size: Int): Bitmap? {
            val retriever = android.media.MediaMetadataRetriever()
            return try {
                retriever.setDataSource(context, audio)
                val bytes = retriever.embeddedPicture ?: return null
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                if (bounds.outWidth <= 0) return null
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= size && bounds.outHeight / (sample * 2) >= size) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            } catch (_: Exception) {
                null
            } finally {
                try { retriever.release() } catch (_: Exception) {}
            }
        }

        /** Another song of the same album that has a cover: albums look the same on every song (an orphan track borrows its album's). */
        private fun albumMateCover(context: Context, trackId: Long, size: Int): Bitmap? {
            val audio = android.content.ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, trackId)
            return try {
                val albumId = context.contentResolver.query(audio, arrayOf(MediaStore.Audio.Media.ALBUM_ID), null, null, null)?.use { if (it.moveToFirst()) it.getLong(0) else null } ?: return null
                val mates = ArrayList<Long>()
                context.contentResolver.query(
                    MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.Audio.Media._ID),
                    "${MediaStore.Audio.Media.ALBUM_ID} = ? AND ${MediaStore.Audio.Media._ID} != ?", arrayOf(albumId.toString(), trackId.toString()),
                    "${MediaStore.Audio.Media.TRACK} ASC",
                )?.use { while (it.moveToNext() && mates.size < 40) mates.add(it.getLong(0)) }
                for (mate in mates) ownCover(context, mate, size)?.let { return it }
                null
            } catch (_: Exception) {
                null
            }
        }

        /** The cover file for a song at a size, made on first use; null when neither the song nor its album has one. */
        fun cover(context: Context, trackId: Long, size: Int): File? {
            val dir = File(context.cacheDir, "covers").apply { mkdirs() }
            val file = File(dir, "$trackId-$size.jpg")
            val none = File(dir, "$trackId-$size.none")
            if (file.isFile) return file
            if (none.isFile) {
                if (System.currentTimeMillis() - none.lastModified() < NONE_VALID_MS) return null
                none.delete()
            }
            val bitmap = ownCover(context, trackId, size) ?: albumMateCover(context, trackId, size)
            if (bitmap == null) {
                none.createNewFile()
                return null
            }
            val partial = File(dir, "$trackId-$size.tmp")
            partial.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 88, it) }
            bitmap.recycle()
            partial.renameTo(file)
            return file
        }
    }
}
