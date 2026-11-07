package expo.modules.t3forkaacrecorder

import kotlin.math.abs
import kotlin.math.log10
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

internal const val SAMPLE_RATE = 16_000
internal const val BYTES_PER_SECOND = SAMPLE_RATE * 2

// 20 ms of audio, so a stop waits at most this long for the read in flight.
private const val CHUNK_BYTES = 640
private const val STOP_TIMEOUT_MS = 3_000L

internal interface PcmSource {
  val capacityBytes: Int
  fun start()
  suspend fun read(buffer: ByteArray, blocking: Boolean): Int
  fun stop()
  fun release()
}

internal interface PcmSink {
  fun start()
  fun write(pcm: ByteArray, count: Int)
  fun finish()
  fun release()
}

/**
 * Microphone to encoder. Stop drains the audio the microphone already captured and flushes the
 * encoder before it returns; Android's MediaRecorder drops that last ~170 ms, a whole syllable.
 */
internal class AacCapture(private val source: PcmSource, private val sink: PcmSink) {
  @Volatile private var stopping = false
  private var worker: Job? = null
  private var released = false
  private val finished = CompletableDeferred<Unit>()

  @Volatile var bytes = 0L
    private set

  @Volatile var metering = -160.0
    private set

  val isRecording get() = worker != null && !finished.isCompleted

  fun start(scope: CoroutineScope, seconds: Double, onFinished: (Throwable?) -> Unit) {
    check(worker == null && !released) { "The microphone is not prepared." }
    var failure: Throwable? = null
    val job = scope.launch {
      failure = runCatching {
        sink.start()
        source.start()
        capture((seconds * BYTES_PER_SECOND).toLong())
        source.stop()
        sink.finish()
      }.exceptionOrNull()
    }
    worker = job
    job.invokeOnCompletion { cause ->
      releaseAll()
      runCatching { onFinished(failure ?: cause) }
      finished.complete(Unit)
    }
  }

  private suspend fun capture(limit: Long) {
    val buffer = ByteArray(CHUNK_BYTES)
    var drained = 0
    while (true) {
      currentCoroutineContext().ensureActive()
      val draining = stopping || bytes >= limit
      val count = source.read(buffer, !draining)
      currentCoroutineContext().ensureActive()
      check(count >= 0) { "The microphone stopped ($count)." }
      if (count == 0) {
        check(draining) { "The microphone stopped supplying audio." }
        return
      }
      sink.write(buffer, count)
      bytes += count
      metering = peakDecibels(buffer, count)
      if (draining) {
        drained += count
        // The microphone keeps capturing while this drains; stop chasing it past its own buffer.
        if (drained > source.capacityBytes) return
      }
    }
  }

  fun requestStop() {
    stopping = true
  }

  suspend fun stop() {
    stopping = true
    if (worker == null) {
      releaseAll()
      return
    }
    if (withTimeoutOrNull(STOP_TIMEOUT_MS) { finished.await() } == null) {
      abort()
      withTimeoutOrNull(STOP_TIMEOUT_MS) { finished.await() }
    }
  }

  fun abort() {
    stopping = true
    val job = worker ?: return releaseAll()
    job.cancel(CancellationException("The recording was cancelled."))
    // A blocking microphone read only returns once the microphone stops.
    runCatching { source.stop() }
  }

  @Synchronized private fun releaseAll() {
    if (released) return
    released = true
    runCatching { source.stop() }
    runCatching { source.release() }
    runCatching { sink.release() }
  }
}

private fun peakDecibels(buffer: ByteArray, count: Int): Double {
  var peak = 0
  for (i in 0 until count - 1 step 2) {
    val sample = ((buffer[i].toInt() and 255) or (buffer[i + 1].toInt() shl 8)).toShort()
    peak = maxOf(peak, abs(sample.toInt()))
  }
  return if (peak == 0) -160.0 else 20 * log10(peak / 32768.0)
}
