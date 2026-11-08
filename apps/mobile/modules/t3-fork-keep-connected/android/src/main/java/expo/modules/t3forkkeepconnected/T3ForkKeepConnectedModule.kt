package expo.modules.t3forkkeepconnected

import android.content.Context
import com.facebook.react.bridge.ReactContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Fork (F21): stay connected for a few minutes after leaving the app (docs/fork/features.md).
class T3ForkKeepConnectedModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext).applicationContext

  override fun definition() = ModuleDefinition {
    Name("T3ForkKeepConnected")

    Function("getMinutes") { KeepConnected.minutes(context) }
    Function("setMinutes") { minutes: Int -> KeepConnected.setMinutes(context, minutes) }
    Function("lastAway") { KeepConnected.report() }

    // Native, not a JS AppState round trip: Android allows a foreground-service start only while
    // the app is still on top or just left it.
    OnActivityEntersBackground {
      val reactContext = appContext.reactContext as? ReactContext
      if (reactContext != null) KeepConnected.onBackground(reactContext.applicationContext, reactContext)
    }
    OnActivityEntersForeground { KeepConnected.onForeground() }
  }
}
