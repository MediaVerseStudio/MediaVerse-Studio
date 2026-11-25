package studio.mediaverse.app

import android.os.Handler
import android.os.Looper
import androidx.media3.exoplayer.ExoPlayer

/**
 * A-B repeat (from Musicolet): mark a start and an end in the playing song and it loops between them, for learning a
 * part or a lyric line. Cleared when the song changes. Main thread only; the player is the service's.
 */
object AbRepeat {
    @Volatile var player: ExoPlayer? = null
    private val handler by lazy { Handler(Looper.getMainLooper()) }
    var a = -1L
        private set
    var b = -1L
        private set

    /** The next tap: sets A, then B (and loops), then clears. Returns what was done: "a", "b" or "off". */
    fun step(positionMs: Long): String {
        if (player == null) return "off"
        return when {
            a < 0 -> { a = positionMs; "a" }
            b < 0 && positionMs - a >= MIN_LOOP_MS -> { b = positionMs; handler.post(watch); "b" }
            else -> { clear(); "off" } // a third tap, or B too close to A
        }
    }

    fun clear() {
        a = -1; b = -1
        handler.removeCallbacks(watch)
    }

    private val watch = object : Runnable {
        override fun run() {
            val p = player ?: return
            if (a < 0 || b < 0) return
            if (shouldJump(p.currentPosition, a, b)) p.seekTo(a)
            handler.postDelayed(this, 150)
        }
    }

    const val MIN_LOOP_MS = 1_000L

    /** Whether the position has reached the end mark (or run past it) while the loop is set. */
    fun shouldJump(position: Long, a: Long, b: Long): Boolean = a >= 0 && b > a && position >= b
}
