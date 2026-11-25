package studio.mediaverse.app

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.audiofx.Equalizer
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import org.json.JSONArray
import org.json.JSONObject

/**
 * An equalizer for each place the sound goes (owner, 2026-11-14, from Musicolet and Poweramp): the phone's speaker,
 * wired headphones, each Bluetooth device (earbuds and the car are told apart by name), USB. Uses Android's own
 * equalizer effect on the player's audio session, so there is no added component. The settings of each output are
 * kept on the phone; when the sound moves to another output, that output's settings are applied.
 */
object OutputEq {
    private const val TAG = "MediaVerseEq"
    private const val FILE = "output_eq"

    /** One connected output: Android's device type and its name. */
    data class Output(val type: Int, val name: String)

    /** The output the sound goes to when several are connected: Bluetooth, then USB, then wired, then the speaker. */
    fun pick(outputs: List<Output>): Output? {
        fun rank(o: Output) = when (o.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_BLE_BROADCAST, AudioDeviceInfo.TYPE_HEARING_AID -> 0
            AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY -> 1
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_LINE_ANALOG, AudioDeviceInfo.TYPE_LINE_DIGITAL -> 2
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> 3
            else -> 9
        }
        return outputs.filter { rank(it) < 9 }.minByOrNull { rank(it) }
    }

    /** The settings key and the words shown for an output: Bluetooth by name, everything else by kind. */
    fun keyOf(o: Output): Pair<String, String> = when (o.type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_BLE_BROADCAST, AudioDeviceInfo.TYPE_HEARING_AID ->
            "bt:${o.name.lowercase()}" to "Bluetooth: ${o.name}"
        AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usb" to "USB audio"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_LINE_ANALOG, AudioDeviceInfo.TYPE_LINE_DIGITAL -> "wired" to "Wired headphones"
        else -> "speaker" to "Phone speaker"
    }

    /** Levels (millibels) for the bands, kept inside the effect's range. */
    fun clampLevels(levels: List<Int>, count: Int, min: Int, max: Int): List<Int> = List(count) { i -> (levels.getOrNull(i) ?: 0).coerceIn(min, max) }

    private var eq: Equalizer? = null
    private var appContext: Context? = null
    private var audioManager: AudioManager? = null

    /** Starts following the player: the effect is rebuilt whenever its audio session changes, and the output is watched. */
    fun attach(context: Context, player: ExoPlayer) {
        appContext = context.applicationContext
        audioManager = context.getSystemService(AudioManager::class.java)
        player.addListener(object : Player.Listener {
            override fun onAudioSessionIdChanged(audioSessionId: Int) = build(audioSessionId)
        })
        build(player.audioSessionId)
        audioManager?.registerAudioDeviceCallback(object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = apply()
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = apply()
        }, Handler(Looper.getMainLooper()))
    }

    fun detach() {
        runCatching { eq?.release() }
        eq = null
    }

    private fun build(session: Int) {
        runCatching { eq?.release() }
        eq = null
        if (session == 0) return
        eq = runCatching { Equalizer(0, session) }.onFailure { Log.i(TAG, "no equalizer: ${it.message}") }.getOrNull()
        apply()
    }

    private fun current(): Pair<String, String> {
        val list = audioManager?.getDevices(AudioManager.GET_DEVICES_OUTPUTS)?.map { Output(it.type, it.productName?.toString() ?: "") } ?: emptyList()
        return keyOf(pick(list) ?: Output(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, ""))
    }

    private fun prefs() = appContext?.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** The settings kept for an output: on or off, and a level per band. */
    private fun saved(key: String): Pair<Boolean, List<Int>> {
        val text = prefs()?.getString(key, null) ?: return false to emptyList()
        val parts = text.split('|')
        return (parts.getOrNull(0) == "1") to (parts.getOrNull(1)?.split(',')?.mapNotNull { it.toIntOrNull() } ?: emptyList())
    }

    /** Puts the current output's settings on the effect. */
    @Synchronized
    fun apply() {
        val e = eq ?: return
        val (key, _) = current()
        val (on, levels) = saved(key)
        runCatching {
            val range = e.bandLevelRange
            val fixed = clampLevels(levels, e.numberOfBands.toInt(), range[0].toInt(), range[1].toInt())
            for (band in 0 until e.numberOfBands) e.setBandLevel(band.toShort(), fixed[band].toShort())
            e.enabled = on
        }.onFailure { Log.i(TAG, "equalizer: ${it.message}") }
    }

    /** What the page shows: the current output, whether its equalizer is on, the bands and their levels. */
    @Synchronized
    fun state(): JSONObject {
        val out = JSONObject()
        val e = eq ?: return out.put("available", false)
        val (key, name) = current()
        val (on, levels) = saved(key)
        val range = e.bandLevelRange
        val count = e.numberOfBands.toInt()
        val hz = JSONArray()
        for (b in 0 until count) hz.put(e.getCenterFreq(b.toShort()) / 1000)
        return out.put("available", true).put("key", key).put("name", name).put("enabled", on)
            .put("min", range[0].toInt()).put("max", range[1].toInt()).put("hz", hz)
            .put("levels", JSONArray(clampLevels(levels, count, range[0].toInt(), range[1].toInt())))
    }

    @Synchronized
    fun set(key: String, enabled: Boolean, levels: List<Int>) {
        if (key != current().first) return // the sound moved to another output since the page last looked
        prefs()?.edit()?.putString(key, (if (enabled) "1" else "0") + "|" + levels.joinToString(","))?.apply()
        apply()
    }
}
