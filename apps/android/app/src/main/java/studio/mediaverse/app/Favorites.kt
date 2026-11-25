package studio.mediaverse.app

import android.content.Context

/**
 * The songs marked with the heart, kept on the phone (song IDs from Android's media index). Kept natively rather
 * than in the page, so the player and Android Auto can offer them too.
 */
object Favorites {
    private const val PREFS = "favorites"
    private const val KEY = "ids"

    fun all(context: Context): Set<String> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(KEY, emptySet()).orEmpty().toSet()

    /** A song was replaced by a new copy with another ID: the heart goes with it. */
    @Synchronized
    fun moved(context: Context, from: String, to: String) {
        if (from !in all(context)) return
        set(context, from, false)
        set(context, to, true)
    }

    @Synchronized
    fun set(context: Context, id: String, on: Boolean) {
        val now = all(context).toMutableSet()
        if (on) now += id else now -= id
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet(KEY, now).apply()
    }
}
