package expo.modules.t3forkaacrecorder

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/** Keeps the microphone on behind a notification while a dictation records in the background. */
class VoiceRecordingService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      onStopRequested?.invoke()
      return START_NOT_STICKY
    }
    // Every startForegroundService call must reach startForeground, even after the recording ended.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        startForeground(
          NOTIFICATION_ID,
          notification(),
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        )
      } else {
        startForeground(NOTIFICATION_ID, notification())
      }
    } catch (_: Exception) {
      // Without background microphone access the recording still runs while the app is open.
      stopSelf()
      return START_NOT_STICKY
    }
    running = this
    if (!wanted) finish()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    if (running === this) running = null
    super.onDestroy()
  }

  private fun finish() {
    if (running === this) running = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun notification(): android.app.Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Voice recording", NotificationManager.IMPORTANCE_LOW)
            .apply {
              setShowBadge(false)
              setSound(null, null)
            }
        )
      }
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val stop = PendingIntent.getService(
      this,
      0,
      Intent(this, VoiceRecordingService::class.java).setAction(ACTION_STOP),
      flags
    )
    val open = packageManager.getLaunchIntentForPackage(packageName)
      ?.let { PendingIntent.getActivity(this, 0, it, flags) }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Recording audio")
      .setContentText("Tap to return to app")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true)
      .setContentIntent(open)
      .addAction(android.R.drawable.ic_delete, "Stop", stop)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setSilent(true)
      .setShowWhen(false)
      .setVisibility(NotificationCompat.VISIBILITY_SECRET)
      .build()
  }

  internal companion object {
    private const val CHANNEL_ID = "t3_voice_recording"
    private const val NOTIFICATION_ID = 2101
    private const val ACTION_STOP = "expo.modules.t3forkaacrecorder.STOP"
    private val main = Handler(Looper.getMainLooper())

    @Volatile private var wanted = false

    @Volatile private var onStopRequested: (() -> Unit)? = null

    // Main thread only.
    private var running: VoiceRecordingService? = null

    fun start(context: Context, onStop: () -> Unit) {
      onStopRequested = onStop
      wanted = true
      try {
        ContextCompat.startForegroundService(
          context,
          Intent(context, VoiceRecordingService::class.java)
        )
      } catch (_: Exception) {
        // Android refuses a foreground service started from the background; record without one.
        wanted = false
      }
    }

    fun stop() {
      wanted = false
      onStopRequested = null
      main.post { if (!wanted) running?.finish() }
    }
  }
}
