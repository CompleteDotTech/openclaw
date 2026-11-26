import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e-contract.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  installOpenAiTalkFixture,
  TALK_READY_HISTORY_MESSAGE,
  waitForTalkReady,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// The product and Web Locks run in Chromium. Gateway, provider responses and
// microphone samples are synthetic; this does not qualify a physical device.
const suite = createControlUiE2eSuite({
  name: "Control UI explicit voice routes",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

type TalkFixtureWindow = Window & {
  openclawVideoTalkE2e?: {
    dataChannelCreated: boolean;
    peer: {
      connectionState: string;
      remoteDescription: RTCSessionDescriptionInit | null;
      channel: EventTarget;
    };
  };
};

async function installVoice(page: Page, id: string) {
  const gateway = await installMockGateway(page, {
    historyMessages: [TALK_READY_HISTORY_MESSAGE],
    deferredMethods: ["talk.session.create", "talk.session.close"],
    methodResponses: {
      "talk.catalog": {
        transcription: { ready: true, providers: [] },
        realtime: { ready: true, providers: [] },
        speech: { providers: [] },
        modes: [],
        transports: [],
        brains: [],
      },
      "talk.session.create": {
        sessionId: id,
        transcriptionSessionId: id,
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      },
      "talk.client.create": {
        provider: "openai",
        transport: "webrtc",
        voiceSessionId: `talk-${id}`,
        clientSecret: "synthetic-client-secret",
      },
    },
  });
  await installOpenAiTalkFixture(page);
  return {
    gateway,
    open: async () => {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("talk.catalog");
      await waitForTalkReady(page);
    },
    textarea: page.locator(".agent-chat__composer-combobox textarea"),
    admit: async () => {
      const request = await gateway.waitForRequest("talk.session.create");
      expect(request.params).toMatchObject({ mode: "transcription", brain: "none" });
      await gateway.resolveDeferred("talk.session.create");
      await page.locator(".agent-chat__dictation-phase--listening").waitFor();
    },
    readyTalk: async () => {
      // The synthetic peer exposes its external open event after the real
      // transport has accepted the fixture's SDP answer.
      await page.waitForFunction(() => {
        const current = (window as TalkFixtureWindow).openclawVideoTalkE2e;
        return (
          current?.dataChannelCreated &&
          current.peer.remoteDescription?.type === "answer" &&
          current.peer.connectionState !== "closed"
        );
      });
      await page.evaluate(() => {
        const channel = (window as TalkFixtureWindow).openclawVideoTalkE2e?.peer.channel;
        if (!channel) {
          throw new Error("Expected the browser Talk data channel");
        }
        channel.dispatchEvent(new Event("open"));
      });
    },
  };
}

async function expectNoAgentWrites(gateway: MockGatewayControls) {
  const forbidden = new Set([
    "agent",
    "chat.send",
    "sessions.companion.ask",
    "sessions.dispatch",
    "tools.invoke",
    "talk.client.toolCall",
    "talk.client.transcript",
    "talk.session.submitToolResult",
  ]);
  expect((await gateway.getRequests()).filter((request) => forbidden.has(request.method))).toEqual(
    [],
  );
}

suite.define(() => {
  it("uses real same-origin Web Locks across windows without replaying a refused capture", () =>
    suite.withPage({ permissions: ["microphone"] }, async ({ page, context }) => {
      const first = await installVoice(page, "first-window");
      await first.open();
      const secondPage = await context.newPage();
      const second = await installVoice(secondPage, "second-window");
      await second.open();
      await page.bringToFront();
      await page.getByRole("button", { name: "Tap to talk", exact: true }).click();
      await first.gateway.waitForRequest("talk.client.create");
      await first.readyTalk();
      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
        .toBeGreaterThan(0);
      await secondPage.bringToFront();
      await secondPage.getByRole("button", { name: "Dictation", exact: true }).click();
      const alert = secondPage.locator(".agent-chat__composer-status-band");
      await expect.poll(() => alert.textContent()).toContain("Microphone inputs are busy");
      expect(["status", "alert"]).toContain(await alert.getAttribute("role"));
      expect(await second.gateway.getRequests("talk.session.create")).toHaveLength(0);
      expect(await second.gateway.getRequests("talk.client.create")).toHaveLength(0);

      await page.close();
      await expect
        .poll(() =>
          secondPage.evaluate(async () =>
            (await navigator.locks.query()).held?.some(
              (lock) => lock.name === "openclaw-voice-capture",
            ),
          ),
        )
        .toBe(false);
      expect(await second.gateway.getRequests("talk.session.create")).toHaveLength(0);
      await secondPage.getByRole("button", { name: "Dictation", exact: true }).click();
      await second.admit();
      await secondPage.keyboard.press("Escape");
      expect((await second.gateway.waitForRequest("talk.session.close")).params).toMatchObject({
        discard: true,
      });
      await second.gateway.resolveDeferred("talk.session.close");
      await expectNoAgentWrites(second.gateway);
      await secondPage.reload();
      await second.textarea.waitFor();
      expect(await second.gateway.getRequests("talk.session.create")).toHaveLength(0);
      expect(await second.gateway.getRequests("talk.client.create")).toHaveLength(0);
    }));
});
