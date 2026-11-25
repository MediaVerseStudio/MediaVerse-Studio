package studio.mediaverse.app

import android.content.Context
import org.json.JSONObject

/**
 * How often and when each song was played, kept on the phone (Most played, Not played yet, Recently played). A song
 * counts as played when it reached half its length or 30 seconds, whichever comes first, before the next one began.
 */
object PlayStats {
    private const val FILE = "play_stats"

    /** Whether a song stopped at `positionMs` of `durationMs` counts as played. */
    fun counts(positionMs: Long, durationMs: Long): Boolean {
        if (positionMs <= 0) return false
        val needed = if (durationMs > 0) minOf(30_000L, durationMs / 2) else 30_000L
        return positionMs >= needed
    }

    @Synchronized
    fun played(context: Context, id: Long, now: Long = System.currentTimeMillis()) {
        val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        prefs.edit().putInt("n:$id", prefs.getInt("n:$id", 0) + 1).putLong("t:$id", now).apply()
    }

    /** A song was replaced by a new copy with another ID: its play count and last time go with it. */
    @Synchronized
    fun moved(context: Context, from: Long, to: Long) {
        val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        val n = prefs.getInt("n:$from", 0)
        if (n == 0) return
        prefs.edit().putInt("n:$to", n).putLong("t:$to", prefs.getLong("t:$from", 0)).remove("n:$from").remove("t:$from").apply()
    }

    /** `{ "<id>": [count, lastPlayedMillis], … }` for every song played at least once. */
    @Synchronized
    fun all(context: Context): JSONObject {
        val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        val out = JSONObject()
        for ((key, value) in prefs.all) {
            if (!key.startsWith("n:") || value !is Int) continue
            val id = key.substring(2)
            out.put(id, org.json.JSONArray().put(value).put(prefs.getLong("t:$id", 0)))
        }
        return out
    }
}
