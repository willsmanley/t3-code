const { AndroidConfig, withAndroidManifest, withMainActivity } = require("expo/config-plugins");

// Android lists any app with an ACTION_ASSIST activity under Settings > Default apps >
// Digital assistant app. Once chosen there, holding the power button or swiping up from a
// bottom corner opens it. MainActivity turns that launch into the New task link, so the
// JS router handles it like the launcher's "New task" shortcut.

const ASSIST_ACTION = "android.intent.action.ASSIST";
const DEFAULT_CATEGORY = "android.intent.category.DEFAULT";

const assistMethods = (newTaskUrl) => `
  // Opens New task when Android launches the app as the digital assistant;
  // added by withAndroidAssistant.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(assistIntentAsNewTaskLink(intent))
  }

  private fun assistIntentAsNewTaskLink(intent: Intent): Intent =
    if (intent.action == Intent.ACTION_ASSIST) {
      Intent(Intent.ACTION_VIEW, Uri.parse("${newTaskUrl}"))
    } else {
      intent
    }
`;

// Before super.onCreate, so React Native's initial URL is the New task link.
const ASSIST_ON_CREATE_CALL = `intent = assistIntentAsNewTaskLink(intent)
    `;

function insertAt(contents, index, insertion) {
  return contents.slice(0, index) + insertion + contents.slice(index);
}

function indexOrThrow(contents, anchor, description) {
  const index = contents.indexOf(anchor);
  if (index === -1) {
    throw new Error(
      `withAndroidAssistant: could not find ${description} in MainActivity — the Expo template changed; update the plugin anchors.`,
    );
  }
  return index;
}

function withAssistIntentFilter(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(nextConfig.modResults);
    const filters = (mainActivity["intent-filter"] ??= []);
    const hasAssist = filters.some((filter) =>
      filter.action?.some((action) => action.$["android:name"] === ASSIST_ACTION),
    );
    if (!hasAssist) {
      filters.push({
        action: [{ $: { "android:name": ASSIST_ACTION } }],
        category: [{ $: { "android:name": DEFAULT_CATEGORY } }],
      });
    }
    return nextConfig;
  });
}

function withAssistLaunchLink(config) {
  const scheme = [config.scheme].flat().find(Boolean) ?? "t3code";
  return withMainActivity(config, (nextConfig) => {
    let contents = nextConfig.modResults.contents;
    if (nextConfig.modResults.language !== "kt") {
      throw new Error("withAndroidAssistant: MainActivity must be Kotlin.");
    }
    if (contents.includes("assistIntentAsNewTaskLink")) {
      return nextConfig;
    }

    const bundleImport = "import android.os.Bundle";
    contents = insertAt(
      contents,
      indexOrThrow(contents, bundleImport, "the android.os.Bundle import") + bundleImport.length,
      "\nimport android.content.Intent\nimport android.net.Uri",
    );
    const classDeclaration = "class MainActivity : ReactActivity() {";
    contents = insertAt(
      contents,
      indexOrThrow(contents, classDeclaration, "the MainActivity class declaration") +
        classDeclaration.length,
      assistMethods(`${scheme}://new`),
    );
    contents = insertAt(
      contents,
      indexOrThrow(contents, "super.onCreate(null)", "the super.onCreate call"),
      ASSIST_ON_CREATE_CALL,
    );

    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
}

module.exports = function withAndroidAssistant(config) {
  return withAssistLaunchLink(withAssistIntentFilter(config));
};
