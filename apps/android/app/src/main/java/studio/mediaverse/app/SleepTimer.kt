package studio.mediaverse.app

import android.os.Handler
import android.os.Looper
import androidx.media3.exoplayer.ExoPlayer

/**
 * The sleep timer (owner, 2026-11-14, from Musicolet and MediaMonkey): after a number of minutes the music fades out
 * over the last [FADE_MS] and pauses, or it pauses when the song that is playing ends. Lives in the app's process so
 * it keeps counting with the screen off; the player is the service's, set while the service runs. Main thread only.
 */
object SleepTimer {
    const val FADE_MS = 20_000L

    @Volatile var player: ExoPlayer? = null
    private val handler by lazy { Handler(Looper.getMainLooper()) }
    private var endAt = 0L
    private var atSongEnd = false

    /** Milliseconds left, or 0 when no timer counts down. */
    fun remainingMs(now: Long = System.currentTimeMillis()): Long = if (endAt > 0) maxOf(1, endAt - now) else 0

    /** True while the timer waits for the playing song to end. */
    fun waitingForSongEnd(): Boolean = atSongEnd

    fun start(minutes: Int) {
        cancel()
        if (minutes <= 0) return
        endAt = System.currentTimeMillis() + minutes * 60_000L
        handler.post(tick)
    }

    fun endOfSong() {
        cancel()
        atSongEnd = true
        player?.pauseAtEndOfMediaItems = true
    }

    /** Called by the service when the song changes: a timer waiting for the song's end has done its job. */
    fun songChanged() {
        if (atSongEnd) cancel()
    }

    fun cancel() {
        handler.removeCallbacks(tick)
        endAt = 0
        if (atSongEnd) player?.pauseAtEndOfMediaItems = false
        atSongEnd = false
        player?.volume = 1f
    }

    private val tick = object : Runnable {
        override fun run() {
            val p = player
            if (endAt == 0L || p == null) return
            val left = endAt - System.currentTimeMillis()
            if (left <= 0) {
                p.pause()
                endAt = 0
                p.volume = 1f
                return
            }
            if (left < FADE_MS) p.volume = fadeLevel(left)
            handler.postDelayed(this, if (left < FADE_MS) 250 else 1000)
        }
    }

    /** The volume (0 to 1) with `left` milliseconds to go, falling in a straight line over the fade. */
    fun fadeLevel(left: Long): Float = (left.toFloat() / FADE_MS).coerceIn(0f, 1f)
}
