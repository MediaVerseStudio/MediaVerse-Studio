package studio.mediaverse.app

import android.content.ComponentName
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * Browses the app's library the way Android Auto does (a MediaBrowser connected to PlaybackService), on a phone or
 * emulator with some music on it and music access granted (`adb shell pm grant studio.mediaverse.app
 * android.permission.READ_MEDIA_AUDIO`).
 */
@RunWith(AndroidJUnit4::class)
class CarBrowseTest {
    private lateinit var browser: MediaBrowser
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun connect() {
        InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.READ_MEDIA_AUDIO)
        assumeTrue("needs music on the device", Library.reload(context).songs.isNotEmpty())
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaBrowser.Builder(context, token).setApplicationLooper(InstrumentationRegistry.getInstrumentation().targetContext.mainLooper).buildAsync()
        browser = future.get(20, TimeUnit.SECONDS)
    }

    @After
    fun release() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync { if (::browser.isInitialized) { browser.stop(); browser.release() } }
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun children(id: String): List<MediaItem> {
        val result: LibraryResult<com.google.common.collect.ImmutableList<MediaItem>> = onMain { browser.getChildren(id, 0, 500, null) }.get(20, TimeUnit.SECONDS)
        assertEquals("children of $id", LibraryResult.RESULT_SUCCESS, result.resultCode)
        return result.value!!
    }

    @Test
    fun theRootHasTheFourTabsAndEachOpens() {
        val root = onMain { browser.getLibraryRoot(null) }.get(20, TimeUnit.SECONDS).value!!
        assertEquals(Browse.ROOT, root.mediaId)
        val tabs = children(Browse.ROOT)
        assertEquals(listOf("Artists", "Albums", "Genres", "Songs"), tabs.map { it.mediaMetadata.title.toString() })
        assertTrue(tabs.all { it.mediaMetadata.isBrowsable == true })

        val albums = children("albums")
        assertTrue("albums listed", albums.isNotEmpty())
        assertEquals(MediaMetadata.MEDIA_TYPE_ALBUM, albums.first().mediaMetadata.mediaType)
        assertTrue("albums have covers", albums.first().mediaMetadata.artworkUri.toString().startsWith("content://studio.mediaverse.app.art/"))

        val songs = children(albums.first().mediaId)
        assertTrue(songs.isNotEmpty() && songs.all { it.mediaMetadata.isPlayable == true })

        val artist = children("artists").first()
        assertTrue(children(artist.mediaId).isNotEmpty())
        val all = children("songs")
        assertEquals("Shuffle all comes first", "shuffle:all", all.first().mediaId)
    }

    @Test
    fun aSongChosenInTheCarPlaysWithTheRestOfItsAlbum() {
        val album = children("albums").first { children(it.mediaId).size >= 3 }
        val songs = children(album.mediaId)
        onMain {
            browser.setMediaItem(songs[1])
            browser.prepare()
        }
        Thread.sleep(3000)
        val (count, index, current) = onMain { Triple(browser.mediaItemCount, browser.currentMediaItemIndex, browser.currentMediaItem?.mediaMetadata?.title?.toString()) }
        assertEquals("the whole album is queued", songs.size, count)
        assertEquals("starting at the chosen song", 1, index)
        assertEquals(songs[1].mediaMetadata.title.toString(), current)
    }

    @Test
    fun shuffleAndRepeatButtonsAreOfferedAndWork() {
        val names = onMain { browser.mediaButtonPreferences.map { it.sessionCommand?.customAction } }
        assertEquals(listOf(PlaybackService.SHUFFLE.customAction, PlaybackService.REPEAT.customAction), names)
        val before = onMain { browser.shuffleModeEnabled }
        onMain { browser.sendCustomCommand(PlaybackService.SHUFFLE, android.os.Bundle.EMPTY) }.get(20, TimeUnit.SECONDS)
        Thread.sleep(500)
        assertEquals(!before, onMain { browser.shuffleModeEnabled })
        onMain { browser.sendCustomCommand(PlaybackService.SHUFFLE, android.os.Bundle.EMPTY) }.get(20, TimeUnit.SECONDS)
    }

    @Test
    fun searchFindsAnArtistsSongs() {
        val artist = Library.get(context).artists.first()
        val word = artist.name.split(" ").first { it.length > 2 }
        onMain { browser.search(word, null) }.get(20, TimeUnit.SECONDS)
        val found = onMain { browser.getSearchResult(word, 0, 50, null) }.get(20, TimeUnit.SECONDS).value!!
        assertTrue("found songs for $word", found.isNotEmpty())
    }
}
