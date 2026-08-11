import assert from "node:assert/strict";
import test from "node:test";
import {
  FetchReadinessProbe,
  LoopbackRuntimeDiscoveryProvider,
  parseLoopbackHttpUrl,
  RuntimeNetworkError,
} from "./network.js";

test("attach URLs accept only credential-free IPv4 loopback HTTP with an explicit port", () => {
  assert.equal(parseLoopbackHttpUrl("http://127.0.0.1:4310/path?view=1").origin, "http://127.0.0.1:4310");
  for (const value of [
    "http://localhost:4310",
    "https://127.0.0.1:4310",
    "http://127.0.0.1",
    "http://user:pass@127.0.0.1:4310",
    "http://127.0.0.1:4310/#fragment",
    "http://0.0.0.0:4310",
  ]) assert.throws(() => parseLoopbackHttpUrl(value), RuntimeNetworkError);
});

test("readiness never follows or accepts redirects", async () => {
  let now = 0;
  const probe = new FetchReadinessProbe({
    fetch: async () => new Response(null, { status: 302, headers: { location: "http://example.com" } }),
    now: () => now,
    intervalMs: 1,
    delay: async (milliseconds) => { now += milliseconds; },
  });
  await assert.rejects(
    probe.wait({ url: "http://127.0.0.1:4310/ready", timeoutMs: 2, signal: new AbortController().signal }),
    /redirect/,
  );
});

test("readiness cancellation interrupts retry delay", async () => {
  const controller = new AbortController();
  const probe = new FetchReadinessProbe({
    fetch: async () => { throw new Error("not ready"); },
    delay: async (_milliseconds, signal) => await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      setImmediate(resolve);
    }),
  });
  const waiting = probe.wait({ url: "http://127.0.0.1:4310/ready", timeoutMs: 5_000, signal: controller.signal });
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(waiting, /cancelled/);
});

test("discovery reports only responding servers from its bounded loopback port set", async () => {
  const requested: string[] = [];
  const discovery = new LoopbackRuntimeDiscoveryProvider({
    ports: [3000, 5173],
    fetch: async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes(":5173")) return new Response(null, { status: 302 });
      throw new Error("connection refused");
    },
  });
  const candidates = await discovery.discover(new AbortController().signal);
  assert.equal(candidates.length, 1);
  assert.match(candidates[0]!.id, /^[a-f0-9]{24}$/);
  assert.deepEqual({ ...candidates[0], id: undefined }, {
    id: undefined,
    url: "http://127.0.0.1:5173/",
    processId: null,
    label: "Local server on port 5173",
  });
  assert.deepEqual(requested.sort(), ["http://127.0.0.1:3000/", "http://127.0.0.1:5173/"]);
});
