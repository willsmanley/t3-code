package expo.modules.t3forkkeepconnected

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Fork (F21): a quiet foreground service that keeps the app's process, network and JS running for
 * the keep-connected window after the user leaves. [KeepConnected] decides when it runs.
 */
class KeepConnectedService : Service() {
  private var lastStartId = 0

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    lastStartId = startId
    if (intent?.action == ACTION_STOP) {
      KeepConnected.onStopRequested()
      if (running == null) stopSelf(startId)
      return START_NOT_STICKY
    }
    val endsAtMs = intent?.getLongExtra(EXTRA_ENDS_AT, 0L) ?: 0L
    // Every startForegroundService call must reach startForeground, even when no longer wanted.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification(endsAtMs),
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
      } else {
        startForeground(NOTIFICATION_ID, notification(endsAtMs))
      }
    } catch (_: Exception) {
      // For example the daily data-sync limit on Android 15; the app sleeps as it used to.
      stopSelf(startId)
      KeepConnected.onServiceFailed()
      return START_NOT_STICKY
    }
    running = this
    if (!wanted) {
      finish()
      return START_NOT_STICKY
    }
    KeepConnected.onServiceStarted()
    return START_NOT_STICKY
  }

  // Android 15 ends data-sync services after six hours a day; the window is far shorter.
  override fun onTimeout(startId: Int, fgsType: Int) {
    KeepConnected.onServiceGone()
    finish()
  }

  override fun onDestroy() {
    // Only a destroy we didn't ask for (task removed, process trimmed) ends the window here.
    if (running === this) {
      running = null
      KeepConnected.onServiceGone()
    }
    super.onDestroy()
  }

  private fun finish() {
    if (running === this) running = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    // A start that arrived after this one keeps the service.
    stopSelf(lastStartId)
  }

  private fun notification(endsAtMs: Long): Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Staying connected", NotificationManager.IMPORTANCE_LOW)
            .apply {
              description = "Shown while T3 Code stays connected after you leave it."
              setShowBadge(false)
              setSound(null, null)
              enableVibration(false)
            }
        )
      }
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val stop = PendingIntent.getService(
      this,
      0,
      Intent(this, KeepConnectedService::class.java).setAction(ACTION_STOP),
      flags
    )
    val open = packageManager.getLaunchIntentForPackage(packageName)
      ?.let { PendingIntent.getActivity(this, 0, it, flags) }
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("T3 Code is staying connected")
      .setContentText("Tap to return. Sleeps when the timer ends.")
      .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
      .setOngoing(true)
      .setContentIntent(open)
      .addAction(android.R.drawable.ic_delete, "Stop", stop)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setSilent(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setVisibility(NotificationCompat.VISIBILITY_SECRET)
    if (endsAtMs > 0L) {
      builder.setWhen(endsAtMs).setShowWhen(true).setUsesChronometer(true)
        .setChronometerCountDown(true)
    } else {
      builder.setShowWhen(false)
    }
    return builder.build()
  }

  internal companion object {
    private const val CHANNEL_ID = "t3_keep_connected"
    private const val NOTIFICATION_ID = 2102
    private const val ACTION_STOP = "expo.modules.t3forkkeepconnected.STOP"
    private const val EXTRA_ENDS_AT = "endsAtMs"

    @Volatile private var wanted = false

    // Main thread only.
    private var running: KeepConnectedService? = null

    /** False when Android refuses to start it (the app is no longer allowed to). */
    fun start(context: Context, endsAtMs: Long): Boolean {
      wanted = true
      return try {
        ContextCompat.startForegroundService(
          context,
          Intent(context, KeepConnectedService::class.java).putExtra(EXTRA_ENDS_AT, endsAtMs)
        )
        true
      } catch (_: Exception) {
        wanted = false
        false
      }
    }

    /** Main thread. A start still on its way stops as soon as it reaches the foreground. */
    fun stop() {
      wanted = false
      running?.finish()
    }
  }
}
