/**
 * The app version reported to the server in `X-Client-Version` (HTTP) and
 * `client_version` (WebSocket connect params). Isolated in its own module
 * like lib/client-os.ts so the headless data-layer tests can mock it
 * instead of pulling expo-constants / expo-modules-core into Node.
 *
 * Primary source is the Expo config version — the same value app.config.ts
 * writes into the installed APK (including the ANDROID_VERSION_NAME
 * override), so server logs split by the version the user actually runs.
 * The previous hardcoded "0.1.0" (apps/mobile/package.json's private
 * version) made that split useless and could not verify any fix shipped
 * afterwards (MULT-34).
 *
 * `nativeApplicationVersion` from expo-application is the fallback: it reads
 * the installed APK's versionName directly, covering the prebuild + gradlew
 * build path this repo uses (scripts/android-build.sh / build-release.sh)
 * where `expoConfig` can come back empty and the primary source would
 * degrade to "unknown" (MULT-34 review). expo-constants 55 removed the
 * old `Constants.nativeAppVersion`; expo-application is its documented
 * replacement.
 */
import { nativeApplicationVersion } from "expo-application";
import Constants from "expo-constants";

export const CLIENT_VERSION: string =
  Constants.expoConfig?.version ?? nativeApplicationVersion ?? "unknown";
