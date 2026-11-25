package studio.mediaverse.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.VolumeProvider
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Handler
import android.os.IBinder
import android.os.Looper

/**
 * Keeps the app running while the phone sends music to a TV or speaker (a notification says so): Android may otherwise
 * freeze a backgrounded app, and the phone must stay connected to load the next song when one ends. Started and
 * stopped by [CastHub]; it plays nothing itself.
 */
class CastService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    // The phone's volume keys: while casting, a "remote" media session takes them and passes them to the device.
    private var remote: MediaSession? = null
    private var provider: VolumeProvider? = null
    private val handler = Handler(Looper.getMainLooper())
    private val follow = object : Runnable {
        override fun run() {
            CastHub.activeVolume()?.let { provider?.currentVolume = Math.round(it * 100).toInt() }
            handler.postDelayed(this, 2000)
        }
    }

    // Android sends the volume keys to a remote session only while its app is really playing sound, so a silent track
    // plays for as long as the cast lasts (as Google's own Cast code does). It makes no noise and takes no audio focus.
    private var silence: Thread? = null

    private fun startSilence() {
        if (silence != null) return
        val thread = Thread({
            val rate = 8000
            val size = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(2048)
            val track = runCatching {
                AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                    .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(size).setTransferMode(AudioTrack.MODE_STREAM).build()
            }.getOrNull() ?: return@Thread
            val zeros = ByteArray(size)
            try {
                track.play()
                while (!Thread.currentThread().isInterrupted) track.write(zeros, 0, zeros.size)
            } catch (_: Exception) {
            } finally {
                runCatching { track.stop() }
                track.release()
            }
        }, "cast-silence")
        thread.isDaemon = true
        silence = thread
        thread.start()
    }

    private fun startVolumeSession() {
        startSilence()
        if (remote != null) return
        val volume = object : VolumeProvider(VOLUME_CONTROL_ABSOLUTE, 100, Math.round((CastHub.activeVolume() ?: 0.3) * 100).toInt()) {
            override fun onSetVolumeTo(volume: Int) {
                android.util.Log.i(CastConnection.TAG, "phone volume key: set to $volume")
                currentVolume = volume.coerceIn(0, 100)
                CastHub.setActiveVolume(currentVolume / 100.0)
            }

            override fun onAdjustVolume(direction: Int) {
                android.util.Log.i(CastConnection.TAG, "phone volume key: adjust $direction")
                if (direction == 0) return
                onSetVolumeTo(currentVolume + if (direction > 0) 5 else -5)
            }
        }
        provider = volume
        remote = MediaSession(this, "MediaVerse cast volume").apply {
            setPlaybackState(PlaybackState.Builder().setState(PlaybackState.STATE_PLAYING, 0, 1f).setActions(0).build())
            // Without a callback the platform drops the volume commands before they reach the provider.
            setCallback(object : MediaSession.Callback() {})
            setPlaybackToRemote(volume)
            isActive = true
        }
        handler.post(follow)
    }

    override fun onDestroy() {
        silence?.interrupt()
        silence = null
        handler.removeCallbacks(follow)
        remote?.release()
        remote = null
        provider = null
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // The notification's Stop button: stop every cast, close the players on the devices, and end this service.
            val app = applicationContext
            Thread({ CastHub.stopAll(app) }, "cast-stop").start()
            stopSelf()
            return START_NOT_STICKY
        }
        val name = intent?.getStringExtra("name") ?: "a TV"
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Playing on a TV or speaker", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_PLAYING, true), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, CastService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stopAction = Notification.Action.Builder(Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel), "Stop", stop).build()
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Playing on $name")
            .setContentText("MediaVerse Studio is sending music to $name")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(stopAction)
            .build()
        startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        startVolumeSession()
        return START_NOT_STICKY
    }

    companion object {
        private const val ACTION_STOP = "studio.mediaverse.app.CAST_STOP"
        private const val CHANNEL = "cast"
        private const val NOTIFICATION = 4711

        fun start(context: Context, name: String) {
            runCatching { context.startForegroundService(Intent(context, CastService::class.java).putExtra("name", name)) }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, CastService::class.java)) }
        }
    }
}
