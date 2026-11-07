package expo.modules.t3forkaacrecorder

import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AacCaptureTest {
  private class Source : PcmSource {
    override val capacityBytes = 32000
    val chunks = Channel<ByteArray>(Channel.UNLIMITED)
    var released = false
    override fun start() = Unit
    override suspend fun read(buffer: ByteArray, blocking: Boolean): Int {
      val chunk = if (blocking) chunks.receive() else chunks.tryReceive().getOrNull() ?: return 0
      chunk.copyInto(buffer)
      return chunk.size
    }
    override fun stop() = Unit
    override fun release() {
      released = true
    }
  }

  private class Sink : PcmSink {
    val pcm = ByteArrayOutputStream()
    val first = CompletableDeferred<Unit>()
    var finished = false
    override fun start() = Unit
    override fun write(pcm: ByteArray, count: Int) {
      check(!finished)
      this.pcm.write(pcm, 0, count)
      first.complete(Unit)
    }
    override fun finish() {
      finished = true
    }
    override fun release() = Unit
  }

  @Test fun stopKeepsTheCapturedTailAndFlushesTheEncoderBeforeReturning() = runTest {
    val source = Source()
    val sink = Sink()
    val capture = AacCapture(source, sink)
    val outcome = CompletableDeferred<Throwable?>()
    val speech = ByteArray(640) { 1 }
    val inFlight = ByteArray(640) { 2 }
    val buffered = ByteArray(320) { 3 }
    capture.start(this, 1200.0) { outcome.complete(it) }
    source.chunks.send(speech)
    sink.first.await()

    val stopped = async(start = CoroutineStart.UNDISPATCHED) { capture.stop() }
    // The read in flight when the user stops, then audio the microphone already holds.
    source.chunks.send(inFlight)
    source.chunks.send(buffered)
    stopped.await()

    assertArrayEquals(speech + inFlight + buffered, sink.pcm.toByteArray())
    assertEquals(1600L, capture.bytes)
    assertTrue(sink.finished)
    assertTrue(source.released)
    assertFalse(capture.isRecording)
    assertTrue(outcome.isCompleted)
    assertNull(outcome.await())
  }
}
