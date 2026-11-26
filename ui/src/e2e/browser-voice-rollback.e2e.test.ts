import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { normalizeControlUiBuildInfo } from "../build-info-normalizers.ts";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e-contract.ts";
import {
  installMockGateway,
  startBuiltControlUiE2eServer,
  type ControlUiE2eProductionServer,
} from "../test-helpers/control-ui-e2e.ts";
import { installTalkBrowserFixtures } from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const parentSha = "92182120e8baa7ce001f41dec7f0bba1489e6636";
const parentAssets = process.env.P06_ROLLBACK_PARENT_ASSETS?.trim();
const childAssets = process.env.P06_ROLLBACK_CHILD_ASSETS?.trim();
const childSha = process.env.P06_ROLLBACK_CHILD_SHA?.trim();
const configured = Boolean(parentAssets || childAssets || childSha);

async function readBuild(directory: string, commit: string) {
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const raw = html.match(/globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su)?.[1];
  if (!raw) {
    throw new Error(`Missing embedded build identity in ${directory}`);
  }
  const identity = normalizeControlUiBuildInfo(JSON.parse(raw));
  expect(identity.commit).toBe(commit);
  expect(identity.dirty).toBe(false);
  expect(identity.buildId).not.toBe("dev");
  return { identity, indexSha256: createHash("sha256").update(html).digest("hex") };
}

async function selectMicrophone(page: Page, label: string, previous: string) {
  await page.getByRole("button", { name: "Dictate", exact: true }).hover();
  await page.getByRole("button", { name: "Microphone input", exact: true }).click();
  expect(await page.getByRole("menuitemradio", { name: previous, exact: true }).getAttribute("aria-checked")).toBe("true");
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
}

async function expectIdle(page: Page, gateway: MockGatewayControls) {
  const forbidden = new Set([
    "talk.session.create", "talk.client.create", "talk.client.transcript", "talk.client.toolCall",
    "talk.session.submitToolResult", "chat.send", "agent", "sessions.companion.ask",
    "sessions.dispatch", "tools.invoke",
  ]);
  expect((await gateway.getRequests()).filter((request) => forbidden.has(request.method))).toEqual([]);
  expect(await page.getByRole("button", { name: "Talk", exact: true }).count()).toBe(0);
  expect(await page.locator(".agent-chat__dictation-status").count()).toBe(0);
  expect(await page.evaluate(() =>
    (window as Window & { openclawVideoTalkTracks?: MediaStreamTrack[] }).openclawVideoTalkTracks?.length ?? 0,
  )).toBe(0);
  expect(await page.evaluate(async () =>
    (await navigator.locks.query()).held?.some((lock) => lock.name === "openclaw-voice-capture"),
  )).toBe(false);
}

// This cross-build proof requires two independently built, exact revision inputs.
// General UI runs report it skipped; a configured proof fails on any missing input.
describe.skipIf(!configured)("Voice rollback proof requires pinned parent and child assets", () => {
  let server: ControlUiE2eProductionServer;
  let directory: string;
  let parent: Awaited<ReturnType<typeof readBuild>>;
  let child: Awaited<ReturnType<typeof readBuild>>;
  const suite = createControlUiE2eSuite({
    name: "Pinned parent to child to parent voice rollback",
    startServerBeforeBrowser: true,
    async startServer() {
      if (!parentAssets || !childAssets || !childSha || !/^[a-f0-9]{40}$/u.test(childSha)) {
        throw new Error("Set P06_ROLLBACK_PARENT_ASSETS, P06_ROLLBACK_CHILD_ASSETS and P06_ROLLBACK_CHILD_SHA together");
      }
      [parent, child] = await Promise.all([
        readBuild(parentAssets, parentSha),
        readBuild(childAssets, childSha),
      ]);
      expect(child.identity.buildId).not.toBe(parent.identity.buildId);
      expect(child.indexSha256).not.toBe(parent.indexSha256);
      directory = await mkdtemp(path.join(os.tmpdir(), "p06-voice-rollback-"));
      try {
        // Publication moves these private copies, never either producer's assets.
        await cp(parentAssets, path.join(directory, "served"), { recursive: true });
        await cp(childAssets, path.join(directory, "next"), { recursive: true });
        server = await startBuiltControlUiE2eServer(path.join(directory, "served"));
        return {
          baseUrl: server.baseUrl,
          close: async () => {
            try {
              await server.close();
            } finally {
              await rm(directory, { recursive: true, force: true });
            }
          },
        };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
  });

  suite.define(() => {
    it("preserves real saved devices and drafts and returns idle after rolling back active dictation", () =>
      suite.withPage({ permissions: ["microphone"], serviceWorkers: "block" }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          serverBuildId: parent.identity.buildId,
          serverVersion: parent.identity.version ?? undefined,
          methodResponses: {
            "talk.catalog": {
              transcription: { ready: true, providers: [] },
              realtime: { ready: false, providers: [] },
            },
            "talk.session.create": {
              sessionId: "rollback-dictation",
              transcriptionSessionId: "rollback-dictation",
              audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
            },
          },
        });
        await installTalkBrowserFixtures(page);
        await page.addInitScript(() => {
          const gatewayUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
          const key = `openclaw.control.settings.v1:${gatewayUrl}`;
          if (!localStorage.getItem(key)) {
            localStorage.setItem(key, JSON.stringify({ gatewayUrl, composerHoldToRecord: true, realtimeTalkInputDeviceId: "usb" }));
          }
        });
        const textarea = page.locator(".new-session-page__message");
        const scopeKey = JSON.stringify(["", "", ""]);
        const stages: Array<{
          stage: string;
          build: typeof parent;
          origin: string;
          draft: string;
          microphone: string;
          idle: true;
        }> = [];
        let completed = false;
        const record = async (stage: string, build: typeof parent, draft: string, microphone: string) => {
          await gateway.waitForRequest("talk.catalog");
          await expect.poll(() => textarea.inputValue()).toBe(draft);
          await waitForCommittedComposerDraft(page, scopeKey, draft, 0);
          expect(await page.evaluate(() => globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO)).toEqual(build.identity);
          const document = await page.request.get(`${server.baseUrl}index.html`);
          expect(createHash("sha256").update(await document.body()).digest("hex")).toBe(build.indexSha256);
          const saved = await page.evaluate(() => {
            const gatewayUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
            return JSON.parse(localStorage.getItem(`openclaw.control.settings.v1:${gatewayUrl}`) ?? "{}");
          });
          expect(saved.realtimeTalkInputDeviceId).toBe(microphone);
          expect(saved).not.toHaveProperty("composerHoldToRecord");
          await page.getByRole("button", { name: "Dictate", exact: true }).hover();
          await page.getByRole("button", { name: "Microphone input", exact: true }).click();
          const label = microphone === "usb" ? "USB Audio Interface" : "Built-in Microphone";
          expect(await page.getByRole("menuitemradio", { name: label, exact: true }).getAttribute("aria-checked")).toBe("true");
          await page.keyboard.press("Escape");
          await expectIdle(page, gateway);
          stages.push({ stage, build, origin: new URL(page.url()).origin, draft, microphone, idle: true });
        };
        try {
          await page.goto(`${server.baseUrl}new`);
          await textarea.fill("Draft created by the pinned parent.");
          await selectMicrophone(page, "Built-in Microphone", "USB Audio Interface");
          await record("parent", parent, "Draft created by the pinned parent.", "built-in");

          await server.replaceBuild(path.join(directory, "next"), path.join(directory, "previous"));
          await gateway.setServerBuildId(child.identity.buildId);
          await page.reload();
          await record("child-restored", child, "Draft created by the pinned parent.", "built-in");
          await textarea.fill("Child edits survive the actual rollback.");
          await selectMicrophone(page, "USB Audio Interface", "Built-in Microphone");
          await record("child-saved", child, "Child edits survive the actual rollback.", "usb");
          await page.getByRole("button", { name: "Dictate", exact: true }).click();
          expect((await gateway.waitForRequest("talk.session.create")).params).toMatchObject({ mode: "transcription", brain: "none" });
          await page.locator('.agent-chat__dictation-status .agent-chat__voice-activity[data-status="listening"]').waitFor();
          expect(await page.evaluate(() =>
            (window as Window & { openclawTalkE2eState?: { constraints: unknown[] } }).openclawTalkE2eState?.constraints,
          )).toEqual([expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: "usb" } }) })]);
          expect(await page.evaluate(async () =>
            (await navigator.locks.query()).held?.some((lock) => lock.name === "openclaw-voice-capture"),
          )).toBe(true);

          await server.replaceBuild(path.join(directory, "previous"), path.join(directory, "child-returned"));
          await gateway.setServerBuildId(parent.identity.buildId);
          await page.reload();
          await record("parent-rollback", parent, "Child edits survive the actual rollback.", "usb");
          expect(new Set(stages.map((stage) => stage.origin)).size).toBe(1);
          completed = true;
        } finally {
          await writeFile(path.join(suite.artifactDir, "rollback-receipt.json"), JSON.stringify({
            parentSha, childSha, parent, child, completed, stages,
            boundary: "Real pinned builds, same Chromium origin/context, localStorage and IndexedDB; synthetic Gateway/media; service workers blocked.",
          }, null, 2));
        }
      }),
    );
  });
});
