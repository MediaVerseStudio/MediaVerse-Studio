package studio.mediaverse.app

import kotlin.random.Random

/**
 * The queue a cast device plays, with the phone's shuffle and repeat buttons applied to it (owner, 2026-11-11: while
 * casting they act on this queue, not on the paused phone). Pure, so it is unit tested.
 * Shuffle mixes the songs still to come (what was already played stays where it is); turning it off puts the original
 * order back around the song that is playing. Repeat: off, all (the queue starts again at its end), one (the same
 * song again when it ends).
 */
class CastQueue(ids: List<Long>, start: Int, private val random: Random = Random.Default) {
    var ids: List<Long> = ids.toList()
        private set
    var index: Int = start
        private set
    var shuffle: Boolean = false
        private set
    var repeat: String = "off"
        private set
    private var original: List<Long> = this.ids

    val current: Long get() = ids[index]

    fun moveTo(i: Int) {
        index = i.coerceIn(0, ids.size - 1)
    }

    /** Turns shuffle on or off; returns the new state. */
    fun toggleShuffle(): Boolean {
        if (!shuffle) {
            original = ids
            ids = ids.take(index + 1) + ids.drop(index + 1).shuffled(random)
            shuffle = true
        } else {
            val now = current
            ids = original
            index = ids.indexOf(now).let { if (it >= 0) it else index.coerceAtMost(ids.size - 1) }
            shuffle = false
        }
        return shuffle
    }

    /** off to all to one to off, as the phone's own button does. */
    fun cycleRepeat(): String {
        repeat = when (repeat) { "off" -> "all"; "all" -> "one"; else -> "off" }
        return repeat
    }

    /** The index to play when the current song has finished by itself; null when the queue is done. */
    fun afterEnd(): Int? = when {
        repeat == "one" -> index
        index + 1 < ids.size -> index + 1
        repeat == "all" -> 0
        else -> null
    }

    /** The index for the Next button: the next song, or the first again when repeating all; null at the end. */
    fun afterNext(): Int? = when {
        index + 1 < ids.size -> index + 1
        repeat != "off" -> 0
        else -> null
    }
}
