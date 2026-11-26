// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserFacingError } from "./connection-error.ts";
import { VoiceRouteSession, type VoiceRoute } from "./voice-route.ts";

const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
const sessions: VoiceRouteSession[] = [];
const lockRequests: Promise<unknown>[] = [];
const releaseGates: Array<() => void> = [];

function routeSession(route: VoiceRoute = "dictation") {
  const value = new VoiceRouteSession({
    route,
    destination: {
      kind: route === "dictation" ? "draft" : route === "talk" ? "conversation" : "command",
      key: "synthetic:session",
    },
    owner: {},
  });
  sessions.push(value);
  return value;
}

// Models only the external Web Locks boundary; real cross-window/device proof
// remains a browser check, not a claim made by this jsdom fixture.
function installLocks(beforeGrant?: () => Promise<void>) {
  const held = new Set<string>();
  const request = vi.fn(
    (name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) => {
      expect(options.ifAvailable).toBe(true);
      const pending = (async () => {
        await beforeGrant?.();
        if (held.has(name)) {
          return await callback(null);
        }
        held.add(name);
        try {
          return await callback({ name, mode: "exclusive" });
        } finally {
          held.delete(name);
        }
      })();
      lockRequests.push(pending);
      return pending;
    },
  );
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
  return { request };
}

function gate() {
  const pending = Promise.withResolvers<void>();
  releaseGates.push(pending.resolve);
  return pending;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.cancel();
  }
  for (const release of releaseGates.splice(0)) {
    release();
  }
  await Promise.allSettled(lockRequests.splice(0));
  if (originalLocks) {
    Object.defineProperty(navigator, "locks", originalLocks);
  } else {
    Reflect.deleteProperty(navigator, "locks");
  }
  vi.restoreAllMocks();
});

describe("voice route identity and capture ownership", () => {
  it("binds an immutable route, generation, destination and cancellation owner", () => {
    const owner = {};
    const destination = { kind: "draft" as const, key: "synthetic:original" };
    const first = new VoiceRouteSession({ route: "dictation", destination, owner });
    sessions.push(first);
    const second = routeSession();
    destination.key = "synthetic:replacement";
    expect(first.identity).toMatchObject({
      route: "dictation",
      destination: { kind: "draft", key: "synthetic:original" },
      cancellationOwner: owner,
    });
    expect(Object.isFrozen(first.identity)).toBe(true);
    expect(Object.isFrozen(first.identity.destination)).toBe(true);
    expect(first.identity.sessionId).not.toBe(second.identity.sessionId);
    expect(first.identity.generation).toBeLessThan(second.identity.generation);
    expect(() => first.requireRoute("talk")).toThrow("activated route");
    expect(() =>
      new VoiceRouteSession({
        route: "dictation",
        destination: { kind: "conversation", key: undefined },
        owner,
      }),
    ).toThrow("destination");
  });

  it("admits one same-realm capture before browser admission and coalesces repeated starts", async () => {
    const admission = gate();
    const locks = installLocks(() => admission.promise);
    const first = routeSession();
    const pending = first.acquireCapture();
    expect(first.acquireCapture()).toBe(pending);
    await expect(routeSession("talk").acquireCapture()).rejects.toBeInstanceOf(UserFacingError);
    expect(locks.request).toHaveBeenCalledOnce();
    admission.resolve();
    await pending;
  });

  it("refuses another window's lock without queueing a later capture", async () => {
    const locks = installLocks();
    const acquired = gate();
    const release = gate();
    const external = locks.request(
      "openclaw-voice-capture",
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        expect(lock).not.toBeNull();
        acquired.resolve();
        await release.promise;
      },
    );
    await acquired.promise;
    const first = routeSession();
    const capture = vi.fn();
    await expect(first.acquireCapture().then(capture)).rejects.toBeInstanceOf(UserFacingError);
    release.resolve();
    await external;
    expect(capture).not.toHaveBeenCalled();
    expect(locks.request).toHaveBeenCalledTimes(2);
    await first.acquireCapture();
    expect(locks.request).toHaveBeenCalledTimes(3);
  });

  it.each(["cancel", "release"] as const)(
    "a delayed callback after %s cannot take over or release a newer capture",
    async (transition) => {
      const admission = gate();
      let firstRequest = true;
      installLocks(() => {
        if (firstRequest) {
          firstRequest = false;
          return admission.promise;
        }
        return Promise.resolve();
      });
      const previous = routeSession();
      const pending = previous.acquireCapture();
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      if (transition === "cancel") {
        previous.cancel();
      } else {
        previous.releaseCapture();
      }
      await rejected;
      const current = transition === "cancel" ? routeSession("talk") : previous;
      await current.acquireCapture();
      admission.resolve();
      await lockRequests[0];
      await expect(routeSession().acquireCapture()).rejects.toBeInstanceOf(UserFacingError);
      expect(current.acceptsResults).toBe(true);
      if (transition === "cancel") {
        await expect(previous.acquireCapture()).rejects.toMatchObject({ name: "AbortError" });
      }
    },
  );

  it("keeps draining dictation bound to its draft without owning Talk's microphone", async () => {
    installLocks();
    const dictation = routeSession();
    await dictation.acquireCapture();
    dictation.releaseCapture();
    await lockRequests[0];
    const talk = routeSession("talk");
    await talk.acquireCapture();
    expect(dictation.acceptsResults).toBe(true);
    expect(() => dictation.requireRoute("dictation")).not.toThrow();
    expect(() => dictation.requireRoute("talk")).toThrow("activated route");
    dictation.complete();
    expect(dictation.acceptsResults).toBe(false);
    expect(dictation.signal.aborted).toBe(true);
    expect(() => dictation.requireRoute("dictation")).toThrow();
    await expect(routeSession().acquireCapture()).rejects.toBeInstanceOf(UserFacingError);
    expect(talk.acceptsResults).toBe(true);
  });

  it("fails explicitly when cross-window coordination is unavailable", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    await expect(routeSession().acquireCapture()).rejects.toBeInstanceOf(UserFacingError);
    installLocks();
    await routeSession().acquireCapture();
  });

  it("releases failed browser admission without changing route or retaining capture", async () => {
    installLocks(() => Promise.reject(new DOMException("Blocked", "SecurityError")));
    const dictation = routeSession();
    await expect(dictation.acquireCapture()).rejects.toBeInstanceOf(UserFacingError);
    expect(dictation.identity.route).toBe("dictation");
    installLocks();
    await routeSession("talk").acquireCapture();
  });

  it("keeps the unavailable command boundary closed before capture or dispatch", async () => {
    const locks = installLocks();
    const command = routeSession("command");
    const dispatch = vi.fn();
    await expect(command.acquireCapture().then(dispatch)).rejects.toBeInstanceOf(UserFacingError);
    expect(() => command.requireRoute("command")).toThrow(UserFacingError);
    expect(locks.request).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    await routeSession().acquireCapture();
  });
});
