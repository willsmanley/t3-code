package expo.modules.t3forkaacrecorder

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import java.io.File
import java.io.FileOutputStream

// Transcribes as well as 44.1 kHz at 96 kbps in half the bytes (fork F16).
private const val BIT_RATE = 48_000
private const val ADTS_HEADER_BYTES = 7
private const val DEQUEUE_TIMEOUT_US = 10_000L
private const val ENCODER_TIMEOUT_NS = 2_000_000_000L

/**
 * AAC-LC in ADTS frames: the file can be read and uploaded while it grows, and still plays after
 * a crash. Each frame goes out in one write, as soon as the encoder produces it.
 */
internal class AdtsAacSink(private val file: File) : PcmSink {
  private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
  private val info = MediaCodec.BufferInfo()
  private var output: FileOutputStream? = null
  private var samples = 0L
  private var ended = false

  init {
    try {
      val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 1)
      format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      format.setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    } catch (error: Throwable) {
      codec.release()
      throw error
    }
  }

  override fun start() {
    output = FileOutputStream(file)
    codec.start()
  }

  override fun write(pcm: ByteArray, count: Int) {
    var offset = 0
    while (offset < count) {
      val index = dequeueInput()
      val buffer = requireNotNull(codec.getInputBuffer(index))
      buffer.clear()
      val size = minOf(buffer.remaining(), count - offset) and 1.inv()
      buffer.put(pcm, offset, size)
      codec.queueInputBuffer(index, 0, size, presentationTimeUs(), 0)
      samples += size / 2
      offset += size
    }
    drain(untilEnd = false)
  }

  /** The encoder holds back ~130 ms of look-ahead until it sees the end of the stream. */
  override fun finish() {
    codec.queueInputBuffer(
      dequeueInput(),
      0,
      0,
      presentationTimeUs(),
      MediaCodec.BUFFER_FLAG_END_OF_STREAM
    )
    drain(untilEnd = true)
    output?.close()
  }

  override fun release() {
    runCatching { output?.close() }
    runCatching { codec.stop() }
    codec.release()
  }

  private fun presentationTimeUs() = samples * 1_000_000 / SAMPLE_RATE

  private fun dequeueInput(): Int {
    val deadline = System.nanoTime() + ENCODER_TIMEOUT_NS
    while (true) {
      val index = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
      if (index >= 0) return index
      drain(untilEnd = false)
      check(System.nanoTime() < deadline) { "The audio encoder stopped taking audio." }
    }
  }

  private fun drain(untilEnd: Boolean) {
    val stream = requireNotNull(output)
    val deadline = System.nanoTime() + ENCODER_TIMEOUT_NS
    while (!ended) {
      val index = codec.dequeueOutputBuffer(info, if (untilEnd) DEQUEUE_TIMEOUT_US else 0)
      if (index >= 0) {
        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
          val frame = ByteArray(ADTS_HEADER_BYTES + info.size)
          writeAdtsHeader(frame)
          val encoded = requireNotNull(codec.getOutputBuffer(index))
          encoded.position(info.offset)
          encoded.get(frame, ADTS_HEADER_BYTES, info.size)
          stream.write(frame)
        }
        codec.releaseOutputBuffer(index, false)
        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) ended = true
      } else if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
        if (!untilEnd) return
        check(System.nanoTime() < deadline) { "The audio encoder did not finish the recording." }
      }
    }
  }
}

/** MPEG-4 AAC-LC, 16 kHz (sampling index 8), mono, no CRC; the length includes the header. */
private fun writeAdtsHeader(frame: ByteArray) {
  val length = frame.size
  frame[0] = 0xFF.toByte()
  frame[1] = 0xF1.toByte()
  frame[2] = ((1 shl 6) or (8 shl 2)).toByte()
  frame[3] = ((1 shl 6) or (length shr 11)).toByte()
  frame[4] = ((length shr 3) and 0xFF).toByte()
  frame[5] = (((length and 7) shl 5) or 0x1F).toByte()
  frame[6] = 0xFC.toByte()
}
