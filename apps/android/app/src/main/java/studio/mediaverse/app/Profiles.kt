package studio.mediaverse.app

import android.content.Context

/**
 * The profile the phone is being used as (D213). Favorites, play counts and the queue are kept in a file per profile,
 * so the player and Android Auto show the current one's. The first profile chosen on a phone takes over the files the
 * phone already had; with no profile chosen those are used too.
 */
object Profiles {
    private const val PREFS = "profiles"

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun current(context: Context): String = prefs(context).getString("current", "").orEmpty()

    /** The file for `base` that belongs to profile `name` (the current one unless said). */
    fun file(context: Context, base: String, name: String = current(context)): String {
        val adopted = prefs(context).getString("adopted", "").orEmpty()
        return if (name.isEmpty() || name.equals(adopted, ignoreCase = true)) base else "$base@${name.lowercase()}"
    }

    /** Every profile's file for `base` (for changes that concern them all, as a song fetched again under a new ID). */
    fun files(context: Context, base: String): List<String> =
        (listOf(base) + prefs(context).getStringSet("known", emptySet()).orEmpty().map { file(context, base, it) }).distinct()

    fun set(context: Context, name: String, adopted: String) {
        val known = prefs(context).getStringSet("known", emptySet()).orEmpty() + name
        prefs(context).edit().putString("current", name).putString("adopted", adopted).putStringSet("known", known).apply()
    }
}
