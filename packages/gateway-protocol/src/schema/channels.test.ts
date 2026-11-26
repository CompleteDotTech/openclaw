import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  validateTalkCatalogParams,
  validateTalkSessionCreateParams,
} from "../validators/integrations.js";
import {
  TalkCatalogResultSchema,
  TalkSessionCloseParamsSchema,
  TalkSessionCreateResultSchema,
} from "./channels.js";

it("admits explicit raw dictation intent and independent transcription catalog selection", () => {
  expect(validateTalkSessionCreateParams({ mode: "transcription", purpose: "dictation" })).toBe(
    true,
  );
  expect(validateTalkSessionCreateParams({ mode: "transcription" })).toBe(true);
  expect(validateTalkSessionCreateParams({ purpose: "conversation" })).toBe(false);
  expect(
    validateTalkCatalogParams({
      provider: "realtime-provider",
      model: "realtime-model",
      transcriptionProvider: "openai",
      transcriptionModel: "selected-transcriber",
    }),
  ).toBe(true);
  expect(validateTalkCatalogParams({ transcriptionModel: "" })).toBe(false);
});

describe("TalkSessionCloseParamsSchema", () => {
  it.each([undefined, "abort", "detach"])("accepts close disposition %s", (disposition) => {
    expect(
      Value.Check(TalkSessionCloseParamsSchema, {
        sessionId: "relay-1",
        ...(disposition ? { disposition } : {}),
      }),
    ).toBe(true);
  });

  it.each(["cancel", "", null, true])("rejects close disposition %s", (disposition) => {
    expect(Value.Check(TalkSessionCloseParamsSchema, { sessionId: "relay-1", disposition })).toBe(
      false,
    );
  });
});

function catalogWithActiveVoicePolicy(activeVoiceSelectionPolicy: unknown) {
  return {
    modes: ["realtime"],
    transports: ["gateway-relay"],
    brains: ["agent-consult"],
    speech: { providers: [] },
    transcription: { providers: [] },
    realtime: {
      providers: [
        {
          id: "realtime",
          label: "Realtime",
          configured: true,
          voices: ["provider-voice"],
          activeVoices: ["active-voice"],
          activeVoiceSelectionPolicy,
        },
      ],
    },
  };
}

describe("TalkCatalogResultSchema", () => {
  it("keeps policy readiness facts distinct and permits a status without private route metadata", () => {
    const dataPolicy = {
      mode: "trusted-endpoint",
      configured: true,
      initialized: false,
      available: true,
      permitted: true,
      transport: "batch",
      reason: "model-unverified",
      message: "Model inference has not been verified.",
      refinement: "unavailable",
    };
    const catalog = {
      ...catalogWithActiveVoicePolicy("allowlist-default"),
      transcription: { providers: [], dataPolicy },
    };
    expect(Value.Check(TalkCatalogResultSchema, catalog)).toBe(true);
    expect(
      Value.Check(TalkSessionCreateResultSchema, {
        sessionId: "dictation-1",
        mode: "transcription",
        transport: "gateway-relay",
        brain: "none",
        dataPolicy,
      }),
    ).toBe(true);
    expect(
      Value.Check(TalkCatalogResultSchema, {
        ...catalog,
        transcription: {
          providers: [],
          dataPolicy: {
            ...dataPolicy,
            provider: "openai",
            model: "synthetic-whisper",
            destination: "http://127.0.0.1:8080/v1",
          },
        },
      }),
    ).toBe(true);
    for (const invalid of [
      { mode: "local" },
      { transport: "live" },
      { initialized: "true" },
      { refinement: "available" },
      { fallback: true },
    ]) {
      expect(
        Value.Check(TalkCatalogResultSchema, {
          ...catalog,
          transcription: { providers: [], dataPolicy: { ...dataPolicy, ...invalid } },
        }),
      ).toBe(false);
    }
  });

  it("accepts optional family Settings facts with only declared Talk transports", () => {
    const catalog = catalogWithActiveVoicePolicy("allowlist-default");
    const modelFamilySettings = {
      family: "example-live",
      unlistedModelVoices: "active",
      unsupportedTransports: ["provider-websocket"],
      gatewayRelayHandlesAgentConsult: true,
      hint: {
        titleKey: "example.title",
        descriptionKey: "example.hint",
        readyKey: "example.ready",
      },
    };
    const withSettings = {
      ...catalog,
      realtime: {
        providers: [{ ...catalog.realtime.providers[0], modelFamilySettings }],
      },
    };

    expect(Value.Check(TalkCatalogResultSchema, catalog)).toBe(true);
    expect(Value.Check(TalkCatalogResultSchema, withSettings)).toBe(true);
    modelFamilySettings.unsupportedTransports = ["unknown-transport"];
    expect(Value.Check(TalkCatalogResultSchema, withSettings)).toBe(false);
  });

  it("accepts only the authoritative voice allowlist policy", () => {
    expect(
      Value.Check(TalkCatalogResultSchema, catalogWithActiveVoicePolicy("allowlist-default")),
    ).toBe(true);
    expect(Value.Check(TalkCatalogResultSchema, catalogWithActiveVoicePolicy("free-form"))).toBe(
      false,
    );
  });
});
