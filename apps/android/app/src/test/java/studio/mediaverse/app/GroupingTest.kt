package studio.mediaverse.app

import org.junit.Assert.assertEquals
import org.junit.Test

/** The phone groups its music like the TV app (web/app/tv/library.test.ts). */
class GroupingTest {
    private var nextId = 1L
    private fun song(folder: String, title: String, artist: String?, album: String?, track: Int? = null, genre: String? = null, albumArtist: String? = null, year: Int? = null, disc: Int? = null) =
        Track(nextId++, title, artist, album, albumArtist, genre, year, track, disc, 180_000, folder)

    @Test
    fun guestSingersAreNotArtistsOfTheirOwn() {
        val pmj = song("Music/PMJ/Swing/", "Song", "Scott Bradlee & Postmodern Jukebox Feat. Haley Reinhart", "Swing", albumArtist = "Scott Bradlee's Postmodern Jukebox")
        val va = song("Music/VA/Fat/", "Song", "mell-ø ft. Ambulo", "Fat Music", albumArtist = "Various Artists")
        assertEquals("Scott Bradlee's Postmodern Jukebox", Grouping.listedArtist(pmj))
        assertEquals("mell-ø", Grouping.listedArtist(va))
        assertEquals("Simon & Garfunkel", Grouping.withoutFeatured("Simon & Garfunkel"))
    }

    @Test
    fun macOsClutterIsNotMusic() {
        assertEquals(true, Grouping.isSystemClutter("._01 Song.mp3", "Music/Band/Album/"))
        assertEquals(true, Grouping.isSystemClutter("01 Song.mp3", "Music/Band/Album/__MACOSX/"))
        assertEquals(false, Grouping.isSystemClutter("01 Song.mp3", "Music/Band/Album/"))
        assertEquals(false, Grouping.isSystemClutter(".hidden fan.mp3", "Music/Band/"))
    }

    @Test
    fun oneAlbumPerFolderInTrackOrderSortedByArtistThenYear() {
        val tracks = listOf(
            song("Music/Orbital/In Sides/", "Petrol", "Orbital", "In Sides", 2, year = 1996),
            song("Music/Orbital/In Sides/", "The Girl With The Sun In Her Head", "Orbital", "In Sides", 1, year = 1996),
            song("Music/The Offspring/Smash/", "Time to Relax", "The Offspring", "Smash", 1, year = 1994),
            song("Music/AFI/Sing The Sorrow/", "Miseria Cantare", "AFI", "Sing The Sorrow", 1, year = 2003),
        )
        val albums = Grouping.albums(tracks)
        assertEquals(listOf("Sing The Sorrow", "Smash", "In Sides"), albums.map { it.title })
        assertEquals("The Girl With The Sun In Her Head", albums[2].tracks.first().title)
        assertEquals("Offspring sorts under O, without The", "The Offspring", albums[1].artist)
    }

    @Test
    fun discsComeBeforeTrackNumbers() {
        val tracks = listOf(
            song("Music/A/B/", "Two-One", "A", "B", 1, disc = 2),
            song("Music/A/B/", "One-Two", "A", "B", 2, disc = 1),
            song("Music/A/B/", "One-One", "A", "B", 1, disc = 1),
        )
        assertEquals(listOf("One-One", "One-Two", "Two-One"), Grouping.albums(tracks).single().tracks.map { it.title })
    }

    @Test
    fun bandsOnlyOnATaggedCompilationAreNotOnTheArtistsList() {
        val tracks = listOf(
            song("Music/Own/", "x", "NOFX", "Punk in Drublic"),
            song("Music/Fat/", "a", "NOFX", "Fat Music", albumArtist = "Various Artists"),
            song("Music/Fat/", "b", "Strung Out feat. A Singer", "Fat Music", albumArtist = "Various Artists"),
        )
        assertEquals(listOf("NOFX"), Grouping.artists(Grouping.albums(tracks)).map { it.name })
        assertEquals(1, Grouping.artists(Grouping.albums(tracks)).single().tracks.size)
    }

    @Test
    fun aCompilationIsVariousArtistsAndEachArtistIsListed() {
        val tracks = listOf(
            song("Music/Comp/", "a", "Band A", "Punk-O-Rama"),
            song("Music/Comp/", "b", "Band B", "Punk-O-Rama"),
            song("Music/Comp/", "c", "Band C", "Punk-O-Rama"),
        )
        val albums = Grouping.albums(tracks)
        assertEquals("Various artists", albums.single().artist)
        assertEquals(listOf("Band A", "Band B", "Band C"), Grouping.artists(albums).map { it.name })
    }

    @Test
    fun genresSplitAndMergeSpellings() {
        val tracks = listOf(
            song("Music/X/1/", "a", "X", "1", 1, "Punk; Ska"),
            song("Music/X/1/", "b", "X", "1", 2, "ska punk"),
            song("Music/X/1/", "c", "X", "1", 3, "Ska Punk"),
            song("Music/X/1/", "d", "X", "1", 4, "(17)"),
        )
        val genres = Grouping.genres(Grouping.albums(tracks))
        assertEquals(listOf("Punk", "Ska", "ska punk"), genres.map { it.name })
        assertEquals(2, genres.last().tracks.size)
    }

    @Test
    fun trackNumbersReadFromTagText() {
        assertEquals(3, Grouping.number("3/12"))
        assertEquals(3, Grouping.number("03"))
        assertEquals(null, Grouping.number("0"))
        assertEquals(null, Grouping.number(null))
    }
}
