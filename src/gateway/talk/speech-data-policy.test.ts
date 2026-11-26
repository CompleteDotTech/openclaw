import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { MediaUnderstandingModelConfig } from "../../config/types.tools.js";
import {
  assertTalkConversationSpeechAllowed,
  captureTalkSpeechDataAuthority,
  isTalkSpeechDataRestricted,
  resolveTalkSpeechDataPlan,
} from "./speech-data-policy.js";

const endpoint = "http://127.0.0.1:8080/private-route/v1";
const selected: MediaUnderstandingModelConfig = {
  provider: "openai",
  model: "fixture-stt",
  capabilities: ["audio"],
};
const noAuth: ModelProviderConfig = { baseUrl: endpoint, models: [], auth: "none" };
function config(): OpenClawConfig {
  return {
    talk: { speechDataPolicy: { mode: "trusted-endpoint", endpoint } },
    models: { providers: { openai: { ...noAuth } } },
    tools: { media: { models: [{ ...selected }] } },
  };
}
const resolve = (cfg: OpenClawConfig) =>
  resolveTalkSpeechDataPlan(cfg, { streamingSelected: false });

describe("Talk speech policy selection", () => {
  it("admits the exact no-auth route without claiming initialization or device locality", () => {
    const plan = resolve(config());
    expect(plan.route).toMatchObject({ baseUrl: endpoint, model: "fixture-stt" });
    expect(plan.readiness).toMatchObject({
      mode: "trusted-endpoint",
      provider: "openai",
      model: "fixture-stt",
      transport: "batch",
      configured: true,
      initialized: false,
      available: false,
      permitted: true,
      destination: "http://127.0.0.1:8080",
      refinement: "unavailable",
    });
    expect(plan.maxBytes).toBe(1_920_044);
  });

  it("keeps a requested device-local route unavailable despite an available cloud key", () => {
    const cfg = config();
    cfg.talk = { speechDataPolicy: { mode: "device-local" } };
    cfg.models = {
      providers: { openai: { ...noAuth, auth: "api-key", apiKey: "synthetic-cloud-key" } },
    };
    expect(resolve(cfg)).toMatchObject({
      readiness: { mode: "device-local", permitted: false, reason: "device-unverified" },
    });
    expect(resolve(cfg).route).toBeUndefined();
    expect(() => assertTalkConversationSpeechAllowed(cfg)).toThrow(/raw composer dictation/);
  });

  it("uses the media owner's preferred model and never skips a denied first route", () => {
    const cfg = config();
    cfg.tools = {
      media: {
        models: [
          { provider: "opaque-plugin", model: "unknown", capabilities: ["audio"] },
          selected,
        ],
      },
    };
    expect(resolve(cfg).readiness.reason).toBe("adapter-unavailable");
    expect(resolve(cfg).route).toBeUndefined();
    cfg.tools.media!.audio = { preferredModel: "openai/fixture-stt" };
    expect(resolve(cfg).route?.model).toBe("fixture-stt");
  });

  it.each([
    { provider: "opaque-plugin", model: "could-infer-audio" },
    { provider: "openai", model: "first-model-with-inferred-capability" },
  ] satisfies MediaUnderstandingModelConfig[])(
    "never skips an ambiguous media capability %j",
    (entry) => {
      const cfg = config();
      cfg.tools = { media: { models: [entry, selected] } };
      expect(resolve(cfg).readiness).toMatchObject({
        permitted: false,
        reason: "adapter-unavailable",
      });
      expect(resolve(cfg).route).toBeUndefined();
    },
  );

  it.each([
    { provider: "opaque-plugin", model: "fixture-stt", capabilities: ["audio"] },
    {
      type: "cli",
      command: "fixture-speech",
      args: ["{{AttachmentPath}}"],
      capabilities: ["audio"],
    },
    { ...selected, command: "fixture-speech" },
  ] satisfies MediaUnderstandingModelConfig[])("denies an unenforced adapter %j", (entry) => {
    const cfg = config();
    cfg.tools = { media: { models: [entry, selected] } };
    expect(resolve(cfg).readiness).toMatchObject({
      permitted: false,
      reason: "adapter-unavailable",
    });
    expect(resolve(cfg).route).toBeUndefined();
  });

  it.each([{ enabled: false }, { deny: ["openai"] }, { entries: { openai: { enabled: false } } }])(
    "honors the existing plugin activation policy %j",
    (plugins) => {
      const cfg = config();
      cfg.plugins = plugins;
      expect(resolve(cfg).readiness).toMatchObject({
        permitted: false,
        reason: "adapter-disabled",
      });
    },
  );

  it.each([
    { auth: "api-key", apiKey: "synthetic-cloud-key" },
    { headers: { "x-fixture": "private-hint" } },
    { request: { proxy: { mode: "explicit-proxy", url: "http://192.0.2.1:3128" } } },
    { localService: { command: "fixture-model-installer" } },
    { params: { temperature: 0.5 } },
  ] satisfies Partial<ModelProviderConfig>[])(
    "denies provider behavior outside the approved adapter %j",
    (override) => {
      const cfg = config();
      cfg.models = { providers: { openai: { ...noAuth, ...override } } };
      expect(resolve(cfg).readiness).toMatchObject({
        permitted: false,
        reason: "transport-unavailable",
      });
    },
  );

  it.each([
    { profile: "openai:private" },
    { preferredProfile: "openai:private" },
    { headers: { "x-fixture": "private-hint" } },
    { request: { headers: { "x-fixture": "private-hint" } } },
    { providerOptions: { fixture: { enabled: true } } },
  ] satisfies Partial<MediaUnderstandingModelConfig>[])(
    "denies model transport overrides %j",
    (override) => {
      const cfg = config();
      cfg.tools = { media: { models: [{ ...selected, ...override }] } };
      expect(resolve(cfg).readiness).toMatchObject({
        permitted: false,
        reason: "transport-unavailable",
      });
    },
  );

  it("checks the effective endpoint after model and capability precedence", () => {
    const cfg = config();
    cfg.tools = { media: { audio: { baseUrl: "https://192.0.2.1/v1" }, models: [selected] } };
    expect(resolve(cfg).readiness.reason).toBe("destination-denied");
    cfg.tools.media!.models = [{ ...selected, baseUrl: endpoint }];
    expect(resolve(cfg).route?.baseUrl).toBe(endpoint);
    cfg.proxy = { enabled: true, proxyUrl: "http://192.0.2.1:3128" };
    expect(resolve(cfg).readiness.reason).toBe("proxy-denied");
  });

  it.each([
    { requestedProvider: "openai" },
    { requestedModel: "fixture-stt" },
    { requestedProvider: "other", requestedModel: "other" },
  ])("refuses request overrides even when they name the configured route: %j", (override) => {
    expect(
      resolveTalkSpeechDataPlan(config(), { streamingSelected: false, ...override }).readiness
        .reason,
    ).toBe("override-denied");
  });

  it("does not reinterpret a configured streaming route or missing media model", () => {
    expect(resolveTalkSpeechDataPlan(config(), { streamingSelected: true }).readiness.reason).toBe(
      "adapter-unavailable",
    );
    const cfg = config();
    cfg.tools = { media: { models: [] } };
    expect(resolve(cfg).readiness.reason).toBe("model-missing");
    cfg.tools.media!.audio = { enabled: false };
    expect(resolve(cfg).readiness.reason).toBe("audio-disabled");
  });
});

describe("Talk captured speech authority", () => {
  it.each(["endpoint", "model", "policy", "hint"] as const)(
    "revokes before a new dispatch when %s changes in place",
    (field) => {
      const cfg = config();
      const current = captureTalkSpeechDataAuthority(cfg, () => cfg);
      expect(current).not.toThrow();
      if (field === "endpoint") {
        cfg.models!.providers!.openai.baseUrl = "https://192.0.2.2/v1";
      } else if (field === "model") {
        cfg.tools!.media!.models![0]!.model = "replacement-model";
      } else if (field === "hint") {
        cfg.tools!.media!.audio = { prompt: "new private hint" };
      } else {
        cfg.talk!.speechDataPolicy = { mode: "external" };
      }
      expect(current).toThrow(expect.objectContaining({ code: "policy-revoked" }));
    },
  );

  it.each([undefined, { mode: "external" as const }])(
    "revokes previously unrestricted capture when restriction is selected: %j",
    (speechDataPolicy) => {
      let cfg: OpenClawConfig = { talk: { speechDataPolicy } };
      const current = captureTalkSpeechDataAuthority(cfg, () => cfg);
      expect(isTalkSpeechDataRestricted(cfg)).toBe(false);
      expect(() => assertTalkConversationSpeechAllowed(cfg)).not.toThrow();
      cfg = config();
      expect(current).toThrow(expect.objectContaining({ code: "policy-revoked" }));
      expect(captureTalkSpeechDataAuthority(cfg, () => cfg)).not.toThrow();
    },
  );

  it("does not revoke unrestricted speech for unrelated configuration updates", () => {
    let cfg: OpenClawConfig = {};
    const current = captureTalkSpeechDataAuthority(cfg, () => cfg);
    cfg = { talk: { speechDataPolicy: { mode: "external" } }, logging: { level: "debug" } };
    expect(current).not.toThrow();
  });
});
