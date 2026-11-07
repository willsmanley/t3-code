package expo.modules.t3forkaacrecorder

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import expo.modules.audio.RecordingInputRoute
import expo.modules.audio.getMapFromDeviceInfo
import expo.modules.audio.recordingInputUid
import expo.modules.audio.recordingInputs
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedObject
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job

/** The recorder interface the composer uses (expo-audio's AudioRecorder), writing ADTS AAC. */
internal class AacVoiceRecorder(
  private val context: Context,
  appContext: AppContext,
  private val scope: CoroutineScope,
  private val onRelease: (String) -> Unit
) : SharedObject(appContext) {
  val id = UUID.randomUUID().toString()
  private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val route =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) RecordingInputRoute(manager) else null
  private var audio: AudioRecord? = null
  private var capture: AacCapture? = null
  private var file: File? = null
  private var inputSelection: Job? = null
  private var inputCanceled = false
  val uri: String? get() = file?.let { Uri.fromFile(it).toString() }

  @SuppressLint("MissingPermission") // The composer asks for the microphone before preparing.
  fun prepare(directory: File) {
    check(capture?.isRecording != true) { "Another voice recording is active." }
    capture?.abort()
    synchronized(this) { inputCanceled = false }
    val capacity = maxOf(
      BYTES_PER_SECOND,
      AudioRecord.getMinBufferSize(
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT
      )
    )
    val recorder = AudioRecord.Builder()
      .setAudioSource(MediaRecorder.AudioSource.MIC)
      .setAudioFormat(
        AudioFormat.Builder().setSampleRate(SAMPLE_RATE)
          .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()
      )
      .setBufferSizeInBytes(capacity)
      .build()
    try {
      check(recorder.state == AudioRecord.STATE_INITIALIZED) { "The microphone could not prepare." }
      directory.mkdirs()
      // savedRecordings.ts lists this folder; the name before the extension is the recording id.
      val target = File(directory, "recording-${UUID.randomUUID()}.aac")
      capture = AacCapture(AudioRecordSource(recorder, capacity, route), AdtsAacSink(target))
      audio = recorder
      file = target
    } catch (error: Throwable) {
      recorder.release()
      throw error
    }
  }

  fun record(seconds: Double) {
    val recording = requireNotNull(capture) { "The microphone is not prepared." }
    val url = uri
    VoiceRecordingService.start(context, recording::requestStop)
    try {
      recording.start(scope, seconds) { error ->
        VoiceRecordingService.stop()
        if (error !is CancellationException) {
          emit(
            "recordingStatusUpdate",
            mapOf(
              "id" to id,
              "isFinished" to true,
              "hasError" to (error != null),
              "error" to error?.message,
              "url" to url
            )
          )
        }
      }
    } catch (error: Throwable) {
      VoiceRecordingService.stop()
      throw error
    }
  }

  suspend fun stop() {
    val selection = synchronized(this) { inputSelection }
    selection?.cancel()
    selection?.join()
    capture?.stop()
  }

  fun status() = mapOf(
    "canRecord" to (capture != null),
    "isRecording" to (capture?.isRecording == true),
    "durationMillis" to (capture?.bytes?.times(1000)?.div(BYTES_PER_SECOND) ?: 0),
    "fileSize" to (file?.length() ?: 0),
    "metering" to (capture?.metering ?: -160.0),
    "mediaServicesDidReset" to false,
    "url" to uri
  )

  fun inputs() = recordingInputs(manager).let { inputs ->
    inputs.map { getMapFromDeviceInfo(it, inputs) }
  }

  @Suppress("TooGenericExceptionCaught") // Release the preferred route on every selection failure.
  suspend fun setInput(uid: String) {
    val job = currentCoroutineContext().job
    synchronized(this) {
      check(!inputCanceled) { "Microphone selection was cancelled." }
      inputSelection = job
    }
    try {
      val inputs = recordingInputs(manager)
      val selected = inputs.firstOrNull { recordingInputUid(it, inputs) == uid }
        ?: error("The preferred microphone is disconnected.")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) route?.select(selected)
      val routed = recordingInputs(manager)
      val source = routed.firstOrNull { it.isSource && recordingInputUid(it, routed) == uid }
        ?: error("The preferred microphone is disconnected.")
      check(audio?.setPreferredDevice(source) == true) { "Could not select the microphone." }
    } catch (error: Throwable) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) route?.close()
      throw error
    } finally {
      synchronized(this) { if (inputSelection === job) inputSelection = null }
    }
  }

  @Synchronized fun cancelInputSelection() {
    inputCanceled = true
    inputSelection?.cancel()
  }

  override fun sharedObjectDidRelease() {
    super.sharedObjectDidRelease()
    cancelInputSelection()
    if (capture?.isRecording == true) VoiceRecordingService.stop()
    capture?.abort()
    onRelease(id)
  }
}

private class AudioRecordSource(
  private val record: AudioRecord,
  override val capacityBytes: Int,
  private val route: java.io.Closeable?
) : PcmSource {
  override fun start() {
    record.startRecording()
    check(record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
      "The microphone could not start."
    }
  }

  override suspend fun read(buffer: ByteArray, blocking: Boolean) = record.read(
    buffer,
    0,
    buffer.size,
    if (blocking) AudioRecord.READ_BLOCKING else AudioRecord.READ_NON_BLOCKING
  )

  override fun stop() {
    if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) record.stop()
  }

  override fun release() {
    try {
      record.release()
    } finally {
      route?.close()
    }
  }
}
