# Mobile notifications

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Ongoing Agent Activity** on Android or **Live Activity Updates** on iOS to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off ongoing activity in Settings to stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Background delivery requires T3 Connect, unless your server sends Android notifications itself (below); a direct or Tailscale connection alone does not enable push notifications. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## Sending Android notifications from your own server

An Android app built with its own Firebase project, such as a fork, cannot receive T3 Connect's notifications. Its servers can send them instead, with the same alerts and ongoing card:

1. Build the app with that project's `google-services.json` and `T3CODE_ANDROID_DIRECT_PUSH=1` (see [Android notifications](../operations/android-notifications.md#firebase-and-app-build)).
2. Create a service-account key for the same Firebase project and save the JSON file as `secrets/fcm-service-account.bin` in the server's T3 home userdata directory (by default `~/.t3/userdata/secrets/fcm-service-account.bin`), readable only by the server's user.
3. Restart the server. Open the app while connected to it and allow notifications.

The app then registers with each connected server that uses its Firebase project, without T3 Connect. Removing the environment from the app, revoking the phone's access on the server, or turning off notification permission stops delivery. With several such servers, the ongoing card shows the most recent server's work.
