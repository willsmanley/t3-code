package expo.modules.t3forkkeepconnected

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.lang.ref.WeakReference

/**
 * Fork (F21): keeps the app running and connected for a few minutes after the user leaves it.
 *
 * Leaving starts [KeepConnectedService] (so Android keeps the process and its network) and a
 * headless JS task (React Native runs JS timers in the background only while one is active, and
 * the connection's probes, retries and debounces are timers). Coming back, the window running
 * out, or the notification's Stop action ends both.
 */
internal object KeepConnected {
  /** Registered in JS by `features/keep-connected/keepConnectedTask.ts`. */
  private const val TASK_KEY = "T3ForkKeepConnected"
  private const val PREFS = "t3_fork_keep_connected"
  private const val KEY_MINUTES = "minutes"
  // React Native ends the task itself this long after the window, should the expiry never run.
  private const val TASK_TIMEOUT_MARGIN_MS = 30_000L

  private val main = Handler(Looper.getMainLooper())
  private val expire: Runnable = Runnable { end(EndReason.EXPIRED) }

  // Written on the main thread; JS reads the report from its own thread.
  private var session: AwaySession? = null
  private var task: Pair<WeakReference<ReactContext>, Int>? = null

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun minutes(context: Context): Int =
    sanitizeMinutes(prefs(context).getInt(KEY_MINUTES, DEFAULT_MINUTES))

  fun setMinutes(context: Context, minutes: Int): Int {
    val value = sanitizeMinutes(minutes)
    prefs(context).edit().putInt(KEY_MINUTES, value).apply()
    return value
  }

  /** The latest time away, or null if the app hasn't left since it started. */
  @Synchronized
  fun report(): Map<String, Any?>? = session?.toMap()

  fun onBackground(context: Context, reactContext: ReactContext?): Unit = onMain {
    val minutes = minutes(context)
    val now = System.currentTimeMillis()
    val started = synchronized(this) {
      // A second pause without a resume between them belongs to the same time away.
      if (session?.isOpen == true) return@onMain
      val next = AwaySession(now, minutes)
      session = next
      if (minutes == 0) next.end(EndReason.OFF, now)
      minutes > 0
    }
    if (!started) return@onMain
    val windowMs = minutes * 60_000L
    if (!KeepConnectedService.start(context, now + windowMs)) {
      end(EndReason.FAILED)
      return@onMain
    }
    startTask(reactContext, windowMs + TASK_TIMEOUT_MARGIN_MS)
    main.postDelayed(expire, windowMs)
  }

  fun onForeground(): Unit = end(EndReason.RETURNED)

  fun onServiceStarted() {
    val now = System.currentTimeMillis()
    synchronized(this) { session?.serviceStarted(now) }
  }

  fun onServiceFailed(): Unit = end(EndReason.FAILED)

  fun onStopRequested(): Unit = end(EndReason.STOPPED)

  /** Android stopped or destroyed the service while it was still wanted. */
  fun onServiceGone(): Unit = end(EndReason.SYSTEM)

  private fun end(reason: EndReason): Unit = onMain {
    val now = System.currentTimeMillis()
    val ended = synchronized(this) { session?.end(reason, now) ?: false }
    if (!ended) return@onMain
    main.removeCallbacks(expire)
    finishTask()
    KeepConnectedService.stop()
  }

  private fun startTask(reactContext: ReactContext?, timeoutMs: Long) {
    if (reactContext == null || !reactContext.hasActiveReactInstance()) return
    try {
      val config = HeadlessJsTaskConfig(TASK_KEY, Arguments.createMap(), timeoutMs, true)
      val id = HeadlessJsTaskContext.getInstance(reactContext).startTask(config)
      task = WeakReference(reactContext) to id
    } catch (_: Exception) {
      // Without the task the socket still stays open; JS timers pause as they always have.
    }
  }

  private fun finishTask() {
    val (contextRef, id) = task ?: return
    task = null
    val reactContext = contextRef.get() ?: return
    val tasks = HeadlessJsTaskContext.getInstance(reactContext)
    if (tasks.isTaskRunning(id)) tasks.finishTask(id)
  }

  private inline fun onMain(crossinline body: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) body() else main.post { body() }
  }
}
