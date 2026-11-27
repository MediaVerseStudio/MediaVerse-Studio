package studio.mediaverse.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ListeningTest {
    @Test
    fun aSongCountsAfterHalfItsLengthOr30SecondsWhicheverIsFirst() {
        assertFalse(PlayStats.counts(0, 200_000))
        assertFalse(PlayStats.counts(10_000, 200_000))
        assertTrue(PlayStats.counts(30_000, 200_000))
        assertTrue(PlayStats.counts(9_000, 18_000)) // a short song: half is enough
        assertFalse(PlayStats.counts(8_000, 18_000))
        assertTrue(PlayStats.counts(31_000, 0)) // unknown length
    }

    @Test
    fun theSleepFadeFallsInAStraightLineAndStaysInRange() {
        assertEquals(1f, SleepTimer.fadeLevel(SleepTimer.FADE_MS), 0.001f)
        assertEquals(0.5f, SleepTimer.fadeLevel(SleepTimer.FADE_MS / 2), 0.001f)
        assertEquals(0f, SleepTimer.fadeLevel(-5), 0.001f)
        assertEquals(1f, SleepTimer.fadeLevel(SleepTimer.FADE_MS * 3), 0.001f)
    }

    @Test
    fun noTimerMeansNothingRemains() {
        assertEquals(0L, SleepTimer.remainingMs())
    }

}
