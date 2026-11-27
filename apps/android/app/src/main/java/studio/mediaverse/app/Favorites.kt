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
        context.getSharedPreferences(Profiles.file(context, PREFS), Context.MODE_PRIVATE).getStringSet(KEY, emptySet()).orEmpty().toSet()

    /** A song was replaced by a new copy with another ID: the heart goes with it. */
    @Synchronized
    fun moved(context: Context, from: String, to: String) {
        for (file in Profiles.files(context, PREFS)) {
            val prefs = context.getSharedPreferences(file, Context.MODE_PRIVATE)
            val ids = prefs.getStringSet(KEY, emptySet()).orEmpty()
            if (from in ids) prefs.edit().putStringSet(KEY, ids - from + to).apply()
        }
    }

    @Synchronized
    fun set(context: Context, id: String, on: Boolean) {
        val now = all(context).toMutableSet()
        if (on) now += id else now -= id
        context.getSharedPreferences(Profiles.file(context, PREFS), Context.MODE_PRIVATE).edit().putStringSet(KEY, now).apply()
    }
}
