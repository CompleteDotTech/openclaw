import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadConfig,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "./config.js";
import {
  resolveConfiguredTalkRealtimeProviderId,
  resolveConfiguredTalkSpeechProviderId,
} from "./talk.js";
import { withTempHomeConfig } from "./test-helpers.js";
import { TalkSchema } from "./zod-schema.root-support.js";

describe("talk config validation fail-closed behavior", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("can load an unpinned runtime config without replacing the process snapshot", async () => {
    await withTempHomeConfig({ gateway: { port: 19002 } }, async () => {
      const unpinned = loadConfig({ skipPluginValidation: true, pin: false });
      expect(unpinned.gateway?.port).toBe(19002);
      expect(getRuntimeConfigSnapshot()).toBeNull();
      const pinned = loadConfig();
      expect(pinned.gateway?.port).toBe(19002);
      expect(getRuntimeConfigSnapshot()).toBe(pinned);
    });
  });

  it.each(["speech", "realtime"] as const)(
    "loads a %s provider whose key differs in case and surrounding whitespace",
    async (scope) => {
      const selection = {
        provider: " ACME ",
        providers: { " Acme ": { voiceId: "synthetic-voice" } },
      };
      const talk = scope === "speech" ? selection : { realtime: selection };
      await withTempHomeConfig({ agents: { entries: { main: {} } }, talk }, async () => {
        const config = loadConfig({ skipPluginValidation: true, pin: false });
        const resolveProvider =
          scope === "speech"
            ? resolveConfiguredTalkSpeechProviderId
            : resolveConfiguredTalkRealtimeProviderId;
        expect(resolveProvider(config)).toBe("Acme");
        const selected = scope === "speech" ? config.talk : config.talk?.realtime;
        expect(selected?.providers?.Acme).toEqual({ voiceId: "synthetic-voice" });
      });
    },
  );

  it("preserves an explicit speech restriction and existing credentials during config load", async () => {
    const talk = {
      provider: "acme",
      providers: { acme: { apiKey: "synthetic-cloud-key", voiceId: "synthetic-voice" } },
      speechDataPolicy: { mode: "device-local" },
    };
    await withTempHomeConfig({ agents: { entries: { main: {} } }, talk }, async () => {
      const config = loadConfig({ skipPluginValidation: true, pin: false });
      expect(config.talk).toEqual(talk);
    });
  });

  it("leaves existing cloud configuration without a speech policy unchanged", async () => {
    const talk = {
      provider: "acme",
      providers: { acme: { apiKey: "synthetic-cloud-key" } },
    };
    await withTempHomeConfig({ agents: { entries: { main: {} } }, talk }, async () => {
      const config = loadConfig({ skipPluginValidation: true, pin: false });
      expect(config.talk).toEqual(talk);
      expect(config.talk).not.toHaveProperty("speechDataPolicy");
    });
  });

  it.each([
    {
      name: "provider absent from providers",
      talk: { provider: "acme", providers: { elevenlabs: { voiceId: "voice-123" } } },
      message: /talk\.provider|talk\.providers|acme/i,
    },
    {
      name: "ambiguous provider selection",
      talk: {
        providers: { acme: { voiceId: "voice-acme" }, elevenlabs: { voiceId: "voice-eleven" } },
      },
      message: /talk\.provider|required/i,
    },
  ])("rejects $name during config load", async ({ talk, message }) => {
    await withTempHomeConfig({ agents: { entries: { main: {} } }, talk }, async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let thrown: unknown;
      try {
        loadConfig();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toMatchObject({
        code: "INVALID_CONFIG",
        message: expect.stringMatching(message),
      });
      expect(consoleSpy).toHaveBeenCalled();
    });
  });
});

describe("Talk speech data policy schema", () => {
  it.each([
    { mode: "device-local" },
    { mode: "trusted-endpoint", endpoint: "http://127.0.0.1:8080/v1" },
    { mode: "external" },
  ])("preserves the explicit $mode policy", (speechDataPolicy) => {
    const parsed = TalkSchema.safeParse({ speechDataPolicy });
    expect(parsed.success && parsed.data.speechDataPolicy).toEqual(speechDataPolicy);
  });

  it.each([
    {},
    { mode: "local" },
    { mode: "device-local", version: 2 },
    { mode: "device-local", endpoint: "http://127.0.0.1:8080/v1" },
    { mode: "trusted-endpoint" },
    { mode: "trusted-endpoint", endpoint: "" },
    { mode: "external", endpoint: "https://speech.example.test/v1" },
    { mode: "external", allowFallback: true },
  ])("rejects unsupported or ambiguous policy %j", (speechDataPolicy) => {
    expect(TalkSchema.safeParse({ speechDataPolicy }).success).toBe(false);
  });

  it.each([
    "file:///speech/model",
    "ftp://speech.example.test/v1",
    "https://user:synthetic-password@speech.example.test/v1",
    "https://speech.example.test/v1?api_key=synthetic-secret",
    "https://speech.example.test/v1#synthetic-fragment",
    " https://speech.example.test/v1 ",
  ])("rejects a non-HTTP or secret-bearing approved endpoint %s", (endpoint) => {
    expect(
      TalkSchema.safeParse({ speechDataPolicy: { mode: "trusted-endpoint", endpoint } }).success,
    ).toBe(false);
  });
});
