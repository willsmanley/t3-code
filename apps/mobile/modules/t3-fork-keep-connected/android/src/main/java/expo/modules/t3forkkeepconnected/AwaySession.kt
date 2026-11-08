package expo.modules.t3forkkeepconnected

/** Why a keep-connected window ended. Only the first reason counts. */
internal enum class EndReason(val wire: String) {
  /** The setting is Off, so nothing ran. */
  OFF("off"),
  /** Android refused the foreground service. */
  FAILED("failed"),
  /** The user came back while the service ran. */
  RETURNED("returned"),
  /** The window ran out. */
  EXPIRED("expired"),
  /** The notification's Stop action. */
  STOPPED("stopped"),
  /** Android stopped the service (time limit, task removed, or killed). */
  SYSTEM("system"),
}

/** One time away from the app, from the moment the activity paused. Main thread only. */
internal class AwaySession(val leftAtMs: Long, val minutes: Int) {
  /** When the service reached the foreground, or null if it never did. */
  var coveredFromMs: Long? = null
    private set
  var endReason: EndReason? = null
    private set
  var endedAtMs: Long? = null
    private set

  val isOpen: Boolean
    get() = endReason == null

  fun serviceStarted(atMs: Long) {
    if (isOpen && coveredFromMs == null) coveredFromMs = atMs
  }

  /** Records the first end; later calls are ignored. Returns whether this call ended it. */
  fun end(reason: EndReason, atMs: Long): Boolean {
    if (!isOpen) return false
    endReason = reason
    endedAtMs = atMs
    return true
  }

  /**
   * True when the service ran from the start of the time away until the return, so the app kept
   * running and stayed connected the whole time. Still open counts: JS can ask before the native
   * foreground hook ends the session.
   */
  val coveredWholeTime: Boolean
    get() = coveredFromMs != null && (endReason == null || endReason == EndReason.RETURNED)

  fun toMap(): Map<String, Any?> =
    mapOf(
      "leftAtMs" to leftAtMs.toDouble(),
      "minutes" to minutes,
      "started" to (coveredFromMs != null),
      "endReason" to endReason?.wire,
      "endedAtMs" to endedAtMs?.toDouble(),
      "coveredWholeTime" to coveredWholeTime,
    )
}

/** The choices the setting offers; anything else falls back to the default. */
internal fun sanitizeMinutes(minutes: Int): Int =
  if (minutes in ALLOWED_MINUTES) minutes else DEFAULT_MINUTES

internal const val DEFAULT_MINUTES = 5
internal val ALLOWED_MINUTES = setOf(0, 1, 5, 10, 15)
