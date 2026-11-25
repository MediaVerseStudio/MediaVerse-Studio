package studio.mediaverse.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class HomeSyncTest {
    @Test
    fun aPlainRelativePathToASongIsAccepted() {
        assertEquals(listOf("Band", "Record", "01 - Song.mp3"), HomeSync.cleanPath("Band/Record/01 - Song.mp3"))
        assertNotNull(HomeSync.cleanPath("A/B.FLAC"))
        assertNotNull(HomeSync.cleanPath("Unknown artist/Unknown album/Intro (2).m4a"))
    }

    @Test
    fun pathsThatLeaveTheFolderOrAreNotSongsAreRefused() {
        for (bad in listOf("", "song.mp3", "../x/song.mp3", "A/../song.mp3", "A//song.mp3", "/A/B/song.mp3", "A\\B\\song.mp3", "C:/A/song.mp3", "A/B/song.txt", "A/B/song", "A/B/so?ng.mp3", "a/b/c/d/e/f/g/song.mp3")) {
            assertNull(bad, HomeSync.cleanPath(bad))
        }
    }

    @Test
    fun theFolderForFetchedSongsIsUnderMusic() {
        assertEquals("Music/MediaVerse Home", HomeSync.ROOT)
    }

    @Test
    fun aFingerprintCoversTheHeadAndTheTailOfASong() {
        assertEquals(emptyList<Pair<Long, Int>>(), HomeSync.fingerprintPieces(0))
        assertEquals(listOf(0L to 1000), HomeSync.fingerprintPieces(1000))
        assertEquals(listOf(0L to 65_536), HomeSync.fingerprintPieces(65_536))
        assertEquals(listOf(0L to 65_536, 65_536L + 100 - 100 to 100), HomeSync.fingerprintPieces(65_636))
        assertEquals(listOf(0L to 65_536, 4_000_000L - 8_192 to 8_192), HomeSync.fingerprintPieces(4_000_000))
    }
}