// @vitest-environment node
// CLIENT_VERSION resolution order (MULT-34 review): the Expo config version
// is primary, the installed APK's native versionName is the fallback, and
// "unknown" only when neither source exists. expo-constants /
// expo-application are native-module wrappers that cannot load in Node, so
// each case mocks them and re-imports the module fresh.
import { describe, expect, it, vi } from "vitest";

async function loadClientVersion(
  constants: Record<string, unknown>,
  application: Record<string, unknown>,
): Promise<string> {
  vi.resetModules();
  vi.doMock("expo-constants", () => ({ default: constants }));
  vi.doMock("expo-application", () => application);
  const mod = await import("./client-version");
  return mod.CLIENT_VERSION;
}

describe("CLIENT_VERSION", () => {
  it("prefers the Expo config version", async () => {
    const version = await loadClientVersion(
      { expoConfig: { version: "2.1.1" } },
      { nativeApplicationVersion: "9.9.9" },
    );
    expect(version).toBe("2.1.1");
  });

  it("falls back to the native versionName when expoConfig is empty", async () => {
    // The prebuild + gradlew path can leave expoConfig null; the APK's
    // versionName is the same value app.config.ts bakes in, including the
    // ANDROID_VERSION_NAME override.
    const version = await loadClientVersion(
      { expoConfig: null },
      { nativeApplicationVersion: "2.1.1" },
    );
    expect(version).toBe("2.1.1");
  });

  it("is unknown only when neither source has a value", async () => {
    // Both sources report null — what the native modules return when the
    // platform has no value for them.
    const version = await loadClientVersion(
      { expoConfig: null },
      { nativeApplicationVersion: null },
    );
    expect(version).toBe("unknown");
    expect(version).not.toBe("0.1.0");
  });
});
