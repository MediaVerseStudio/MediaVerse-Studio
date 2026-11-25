package studio.mediaverse.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class CastQueueTest {
    private fun queue(at: Int = 0) = CastQueue(listOf(1L, 2, 3, 4, 5, 6), at, Random(7))

    @Test
    fun theQueueEndsWhenRepeatIsOff() {
        val q = queue(5)
        assertNull(q.afterEnd())
        assertNull(q.afterNext())
        q.moveTo(2)
        assertEquals(3, q.afterEnd())
        assertEquals(3, q.afterNext())
    }

    @Test
    fun repeatAllStartsAgainAndRepeatOneKeepsTheSong() {
        val q = queue(5)
        assertEquals("all", q.cycleRepeat())
        assertEquals(0, q.afterEnd())
        assertEquals(0, q.afterNext())
        assertEquals("one", q.cycleRepeat())
        assertEquals(5, q.afterEnd())
        assertEquals("the Next button still moves on", 0, q.afterNext())
        assertEquals("off", q.cycleRepeat())
    }

    @Test
    fun shuffleMixesOnlyWhatIsToCome() {
        val q = queue(2)
        assertTrue(q.toggleShuffle())
        assertEquals("what was played and the current song stay", listOf(1L, 2, 3), q.ids.take(3))
        assertEquals(setOf(4L, 5, 6), q.ids.drop(3).toSet())
        assertEquals(3L, q.current)
        assertEquals(6, q.ids.size)
    }

    @Test
    fun turningShuffleOffRestoresTheOrderAroundTheCurrentSong() {
        val q = queue(0)
        q.toggleShuffle()
        q.moveTo(3) // some song of the mixed order
        val playing = q.current
        assertFalse(q.toggleShuffle())
        assertEquals(listOf(1L, 2, 3, 4, 5, 6), q.ids)
        assertEquals(playing, q.current)
    }
}
