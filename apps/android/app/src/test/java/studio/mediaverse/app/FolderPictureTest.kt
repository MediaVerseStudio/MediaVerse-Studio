package studio.mediaverse.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FolderPictureTest {
    @Test
    fun theCoverIsPickedByName() {
        assertEquals("Cover.JPG", ArtProvider.pickFolderPicture(listOf("01 a.mp3", "Cover.JPG", "folder.jpg")))
        assertEquals("Folder.png", ArtProvider.pickFolderPicture(listOf("back.jpg", "Folder.png")))
    }

    @Test
    fun aNameSayingCoverOrFrontIsTheFallbackButNeverTheBack() {
        assertEquals("JointheClub.cover.png", ArtProvider.pickFolderPicture(listOf("JointheClub.cover.png", "x.mp3")))
        assertNull(ArtProvider.pickFolderPicture(listOf("Album back cover.jpg", "DSC04148.JPG")))
        assertNull(ArtProvider.pickFolderPicture(listOf("01 a.mp3")))
    }
}
