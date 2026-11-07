package expo.modules.t3forkaacrecorder

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withContext

// Fork (F8): Android dictation records through this instead of expo-audio's MediaRecorder.
class T3ForkAacRecorderModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val recorders = ConcurrentHashMap<String, AacVoiceRecorder>()

  override fun definition() = ModuleDefinition {
    Name("T3ForkAacRecorder")

    Class(AacVoiceRecorder::class) {
      Constructor {
        AacVoiceRecorder(requireNotNull(appContext.reactContext), appContext, scope) {
          recorders.remove(it)
        }.also { recorders[it.id] = it }
      }
      Property("uri") { recorder -> recorder.uri }
      AsyncFunction("prepareToRecordAsync") Coroutine { recorder: AacVoiceRecorder ->
        // expo-audio's `directory: "document"`, where savedRecordings.ts looks.
        val directory = File(appContext.persistentFilesDirectory, "Audio")
        withContext(Dispatchers.IO) { recorder.prepare(directory) }
      }
      Function("record") { recorder: AacVoiceRecorder, options: Map<String, Double> ->
        recorder.record(options["forDuration"] ?: 1200.0)
      }
      AsyncFunction("stop") Coroutine { recorder: AacVoiceRecorder -> recorder.stop() }
      Function("getStatus") { recorder: AacVoiceRecorder -> recorder.status() }
      Function("getAvailableInputs") { recorder: AacVoiceRecorder -> recorder.inputs() }
      AsyncFunction("setInput") Coroutine { recorder: AacVoiceRecorder, uid: String ->
        recorder.setInput(uid)
      }
      Function("cancelInputSelection") { recorder: AacVoiceRecorder ->
        recorder.cancelInputSelection()
      }
    }

    OnDestroy {
      recorders.values.toList().forEach { it.sharedObjectDidRelease() }
      scope.cancel()
    }
  }
}
