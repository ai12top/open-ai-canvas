import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import localforage from "localforage";
import { useUserStore } from "../src/stores/use-user-store";
import * as imageStorage from "../src/services/image-storage";
import * as fileStorage from "../src/services/file-storage";
import * as browserPlugin from "../src/services/api/browser-plugin";
import { createModelChannel, defaultConfig, encodeChannelModel, useConfigStore } from "../src/stores/use-config-store";
import { readBrowserGeneration, writeBrowserGeneration, type BrowserGenerationRecord } from "../src/services/browser-generation-store";
import { resolveBrowserExecution, queryBrowserGeneration, submitBrowserGeneration } from "../src/services/browser-generation-runner";

const originalFetch = globalThis.fetch;
const originalBridge = globalThis.yingceBrowserProtocol;
const fixtureManifest = { id: "fixture", contributes: { providers: [{ id: "fixture" }] } } as browserPlugin.BrowserPluginManifest;
const originalUser = useUserStore.getState();
const originalConfig = useConfigStore.getState().config;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let records = new Map<string, unknown>();
let restores: Array<{ mockRestore(): void }> = [];
let blobs = new Map<string, Blob>();

/** Declarative plugin channel: the protocol id is not a standard OpenAI alias. */
function pluginChannel(id: string, models: string[], capability: "image" | "video") {
    return createModelChannel({
        id, scope: "user", apiFormat: "openai", baseUrl: "https://gw.example.com/v1", apiKey: "synthetic-plugin-key",
        models, interfaceType: id,
        modelCosts: models.map((model) => ({ model, capability, protocol: id, billingMode: "fixed_request" as const, unitPriceMicrocredits: 0 })),
    });
}

const imageChannel = pluginChannel("libtv-image", ["libtv/lib-image-2.5-s"], "image");
const videoChannel = pluginChannel("libtv-video", ["libtv/lib-video-2.5"], "video");
function pluginConfig(channel: ReturnType<typeof pluginChannel>, model: string) {
    return { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, model) };
}

beforeEach(() => {
    // Runner tests fake protocol translation; the real WASM contract has a separate offline check.
    globalThis.yingceBrowserProtocol = (input) => {
        const call = JSON.parse(input);
        if (call.op === "normalizeImage") return JSON.stringify({ ok: true, data: call.request });
        if (call.op === "prepareHTTP") return JSON.stringify({ ok: true, data: { headers: [{ name: "Authorization", value: `Bearer ${call.credentials.apiKey}` }] } });
        return JSON.stringify({ ok: false, error: `unexpected op ${call.op}` });
    };
    records = new Map();
    blobs = new Map();
    restores = [
        spyOn(localforage, "getItem").mockImplementation(async (key) => structuredClone(records.get(key) ?? null)),
        spyOn(localforage, "setItem").mockImplementation(async (key, value) => { records.set(key, structuredClone(value)); return value; }),
        spyOn(localforage, "iterate").mockImplementation(async (callback) => { for (const [key, value] of records) callback(structuredClone(value), key, 0); }),
        spyOn(imageStorage, "setImageBlob").mockImplementation(async (key, blob) => { blobs.set(key, blob); return "blob:mock"; }),
        spyOn(imageStorage, "getImageBlob").mockImplementation(async (key) => blobs.get(key) || null),
        spyOn(fileStorage, "setMediaBlob").mockImplementation(async (key, blob) => { blobs.set(key, blob); return "blob:mock"; }),
        spyOn(fileStorage, "getMediaBlob").mockImplementation(async (key) => blobs.get(key) || null),
    ];
    const held = new Set<string>();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
        request: async (name: string, run: () => unknown) => { held.add(name); try { return await run(); } finally { held.delete(name); } },
        query: async () => ({ held: [...held].map((name) => ({ name })), pending: [] }),
    } } });
    useUserStore.setState({ user: null, hydrated: true });
    useConfigStore.setState({ config: pluginConfig(imageChannel, "libtv/lib-image-2.5-s") });
});
afterEach(() => {
    for (const restore of [...restores].reverse()) restore.mockRestore();
    useUserStore.setState(originalUser);
    useConfigStore.setState({ config: originalConfig });
    globalThis.fetch = originalFetch;
    globalThis.yingceBrowserProtocol = originalBridge;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else Reflect.deleteProperty(globalThis, "navigator");
});

async function settled(id: string) {
    // The runner polls every 2.5s; give it two intervals before failing.
    for (let attempt = 0; attempt < 600; attempt++) {
        const { task } = await readBrowserGeneration(id);
        if (task.status === "succeeded" || task.status === "failed") return task;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Plugin execution did not settle");
}

/** The runner always resolves against the live store config, so tests must install it too. */
function setConfig(config: ReturnType<typeof defaultConfig>) {
    useConfigStore.setState({ config });
    return config;
}

/** Real plugin paths, minus the network: only the shared transport/download boundary is faked. */
function stubPlugin(create: browserPlugin.BrowserPluginResult, poll?: browserPlugin.BrowserPluginResult[]) {
    const calls = { load: 0, create: 0, poll: 0, result: 0 };
    restores.push(spyOn(browserPlugin, "resolveBrowserPlugin").mockImplementation(async () => { calls.load++; return fixtureManifest; }));
    restores.push(spyOn(browserPlugin, "createBrowserPluginTask").mockImplementation(async () => { calls.create++; return create; }));
    const queue = [...(poll || [])];
    restores.push(spyOn(browserPlugin, "pollBrowserPluginTask").mockImplementation(async () => { calls.poll++; return queue.length > 1 ? queue.shift()! : queue[0]; }));
    restores.push(spyOn(browserPlugin, "fetchBrowserPluginResult").mockImplementation(async () => { calls.result++; return create; }));
    return calls;
}

function mediaFetch(blob: Blob, assertCredentials = true) {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url, options) => {
        if (assertCredentials) expect(options?.credentials).toBe("omit");
        const raw = (options?.headers || {}) as Record<string, string>;
        seen.push({ url: String(url), headers: Object.fromEntries(Object.entries(raw).map(([name, value]) => [name.toLowerCase(), value])) });
        return new Response(blob);
    }) as typeof fetch;
    return seen;
}

// 插件判定走 catalog，所以这里只模拟判定结果：libtv 协议可执行，openai-video 仍走内置 OpenAI。
test("declarative plugins accept multi-reference media while standard OpenAI keeps its own limits", async () => {
    restores.push(spyOn(browserPlugin, "resolveBrowserPlugin").mockImplementation(async (config) => (config.interfaceType || "").includes("libtv") ? { id: "fixture" } as browserPlugin.BrowserPluginManifest : undefined));
    const images = [{ id: "a" }, { id: "b" }];
    await expect(resolveBrowserExecution({
        config: pluginConfig(videoChannel, "libtv/lib-video-2.5"), mode: "video", prompt: "x",
        referenceImages: images as never, referenceVideos: [{ id: "v" }] as never, referenceAudios: [{ id: "s" }] as never,
    })).resolves.toMatchObject({ manifest: { id: "fixture" } });
    const openai = createModelChannel({
        ...pluginChannel("std", ["shared"], "video"), interfaceType: "openai-video",
        modelCosts: [{ model: "shared", capability: "video", protocol: "openai-video", billingMode: "fixed_request" as const, unitPriceMicrocredits: 0 }],
    });
    await expect(resolveBrowserExecution({ config: pluginConfig(openai, "shared"), mode: "video", prompt: "x", referenceImages: images as never })).rejects.toThrow("一张参考图");
    await expect(resolveBrowserExecution({ config: pluginConfig(openai, "shared"), mode: "video", prompt: "x", referenceAudios: [{ id: "s" }] as never })).rejects.toThrow("参考视频或音频");
    // Text and audio stay on the standard path: a non-OpenAI protocol is refused there.
    await expect(resolveBrowserExecution({ config: pluginConfig(videoChannel, "libtv/lib-video-2.5"), mode: "text", prompt: "x" })).rejects.toThrow("仅支持标准 OpenAI");
});

test("a plugin whose provider id shadows a built-in protocol still runs through the manifest", async () => {
    const calls = stubPlugin({ status: "succeeded", taskId: "up-shadow", result: { images: [{ url: "https://gw.example.com/v1/files/out.png" }] } });
    mediaFetch(new Blob(["synthetic png"], { type: "image/png" }));
    const shadow = pluginChannel("openai-image", ["shared-image"], "image");
    const config = setConfig(pluginConfig(shadow, "shared-image"));
    await submitBrowserGeneration({ config, mode: "image", prompt: "A tree", clientOperationId: "shadow-image" });
    expect((await settled("browser:shadow-image")).status).toBe("succeeded");
    expect(calls.create).toBe(1);
});

test("a synchronous plugin image result is saved through the existing artifact path", async () => {
    const calls = stubPlugin({ status: "succeeded", taskId: "up-sync", result: { images: [{ url: "https://gw.example.com/v1/files/out.png" }] } });
    const seen = mediaFetch(new Blob(["synthetic png"], { type: "image/png" }));
    const config = setConfig(pluginConfig(imageChannel, "libtv/lib-image-2.5-s"));
    const task = await submitBrowserGeneration({ config, mode: "image", prompt: "A tree", clientOperationId: "plugin-image" });
    const done = await settled(task.id);
    expect(done.status).toBe("succeeded");
    expect(done.resultJson).toContain("image:guest:browser:plugin-image:0");
    expect(calls.create).toBe(1);
    expect(calls.load).toBe(1);
    expect(seen.length).toBe(1);
    // The key belongs to the channel the user picked, so only that origin may receive it.
    expect(seen[0].headers.authorization).toBe("Bearer synthetic-plugin-key");
    expect(JSON.stringify([...records.values()])).not.toContain("synthetic-plugin-key");
    // A result hosted elsewhere is downloaded anonymously.
    restores.push(spyOn(browserPlugin, "fetchBrowserPluginResult").mockImplementation(async () => ({ status: "succeeded" as const, taskId: "up-cdn", result: { images: [{ url: "https://cdn.example.net/out.png" }] } })));
    restores.push(spyOn(browserPlugin, "createBrowserPluginTask").mockImplementation(async () => ({ status: "succeeded" as const, taskId: "up-cdn", result: { images: [{ url: "https://cdn.example.net/out.png" }] } })));
    const cdn = await submitBrowserGeneration({ config, mode: "image", prompt: "A tree", clientOperationId: "plugin-cdn" });
    expect((await settled(cdn.id)).status).toBe("succeeded");
    expect(seen[1].url).toBe("https://cdn.example.net/out.png");
    expect(seen[1].headers.authorization).toBeUndefined();
});

test("an asynchronous plugin task polls to completion and keeps no handle on disk afterwards", async () => {
    const calls = stubPlugin(
        { status: "pending", taskId: "up-async", result: undefined },
        [{ status: "processing", taskId: "up-async" }, { status: "succeeded", taskId: "up-async", result: { images: [{ url: "https://gw.example.com/v1/files/out.png" }] } }],
    );
    mediaFetch(new Blob(["synthetic png"], { type: "image/png" }));
    const task = await submitBrowserGeneration({ config: setConfig(pluginConfig(imageChannel, "libtv/lib-image-2.5-s")), mode: "image", prompt: "A tree", clientOperationId: "plugin-async" });
    expect((await settled(task.id)).status).toBe("succeeded");
    expect(calls.create).toBe(1);
    expect(calls.poll).toBeGreaterThanOrEqual(2);
    // 结果已落盘，句柄（含参考素材与请求快照）不再保留。
    expect((await readBrowserGeneration(task.id)).pluginTask).toBeUndefined();
});

test("a paused plugin record resumes from the persisted handle and never re-creates the task", async () => {
    const calls = stubPlugin({ status: "succeeded", taskId: "up-async", result: { images: [{ url: "https://gw.example.com/v1/files/out.png" }] } });
    restores.push(spyOn(browserPlugin, "pollBrowserPluginTask").mockImplementation(async () => { calls.poll++; return { status: "succeeded" as const, taskId: "up-async", result: { images: [{ url: "https://gw.example.com/v1/files/out.png" }] } }; }));
    mediaFetch(new Blob(["synthetic png"], { type: "image/png" }));
    setConfig(pluginConfig(imageChannel, "libtv/lib-image-2.5-s"));
    const id = "browser:plugin-paused";
    const now = new Date().toISOString();
    await writeBrowserGeneration({
        task: { id, executionSource: "browser", clientOperationId: "plugin-paused", type: "canvas_image", operation: "image", prompt: "A tree", model: "libtv-image::libtv/lib-image-2.5-s", status: "failed", stage: "query_paused", attempts: 1, createdAt: now, updatedAt: now },
        channelId: "libtv-image", baseUrl: "https://gw.example.com/v1", protocol: "libtv-image",
        pluginTask: { manifest: fixtureManifest, request: {}, taskId: "up-async" },
    });
    expect((await queryBrowserGeneration(id)).status).toBe("succeeded");
    expect(calls.create).toBe(0);
    expect(calls.poll).toBe(1);
});

test("a failed plugin download keeps its receipt so recovery reuses the task instead of generating again", async () => {
    const calls = stubPlugin({ status: "succeeded", taskId: "up-video", result: { videos: [{ url: "https://gw.example.com/v1/files/out.mp4" }] } });
    globalThis.fetch = (async () => { throw new TypeError("download interrupted"); }) as typeof fetch;
    const config = setConfig(pluginConfig(videoChannel, "libtv/lib-video-2.5"));
    const task = await submitBrowserGeneration({ config, mode: "video", prompt: "A river", clientOperationId: "plugin-video" });
    const paused = await settled(task.id);
    expect(paused.status).toBe("failed");
    expect(paused.canRecoverMedia).toBe(true);
    expect((await readBrowserGeneration(task.id)).pendingMedia?.sources).toEqual(["https://gw.example.com/v1/files/out.mp4"]);
    mediaFetch(new Blob(["synthetic mp4"], { type: "video/mp4" }));
    const recovered = await queryBrowserGeneration(task.id);
    expect(recovered.status).toBe("succeeded");
    expect(recovered.resultJson).toContain("video:guest:browser:plugin-video:0");
    expect((await readBrowserGeneration(task.id)).pendingMedia).toBeUndefined();
    expect(calls.create).toBe(1);
});

test("a succeeded plugin task without inline media downloads through the declared result endpoint", async () => {
    let resultCalls = 0;
    stubPlugin({ status: "succeeded", taskId: "up-binary", result: {} });
    restores.push(spyOn(browserPlugin, "fetchBrowserPluginResult").mockImplementation(async () => { resultCalls++; return { status: "succeeded" as const, taskId: "up-binary", result: { images: [{ url: "https://gw.example.com/v1/files/out.png" }] } }; }));
    mediaFetch(new Blob(["synthetic png"], { type: "image/png" }));
    const task = await submitBrowserGeneration({ config: setConfig(pluginConfig(imageChannel, "libtv/lib-image-2.5-s")), mode: "image", prompt: "A tree", clientOperationId: "plugin-binary" });
    expect((await settled(task.id)).status).toBe("succeeded");
    expect(resultCalls).toBe(1);
});

test("replaying the same client operation id never submits a second plugin task", async () => {
    const calls = stubPlugin({ status: "succeeded", taskId: "up-once", result: { images: [{ url: "https://gw.example.com/v1/files/out.png" }] } });
    mediaFetch(new Blob(["synthetic png"], { type: "image/png" }));
    const request = { config: setConfig(pluginConfig(imageChannel, "libtv/lib-image-2.5-s")), mode: "image" as const, prompt: "A tree", clientOperationId: "plugin-once" };
    const first = await submitBrowserGeneration(request);
    expect((await settled(first.id)).status).toBe("succeeded");
    expect((await submitBrowserGeneration(request)).id).toBe(first.id);
    expect(calls.create).toBe(1);
});

test("a changed original channel blocks plugin recovery before any credential is sent", async () => {
    // A reloaded page owns no in-flight run: the durable handle is the only thing left.
    const id = "browser:plugin-stale";
    const now = new Date().toISOString();
    await writeBrowserGeneration({
        task: { id, executionSource: "browser", clientOperationId: "plugin-stale", type: "canvas_image", operation: "image", prompt: "A tree", model: "libtv-image::libtv/lib-image-2.5-s", status: "failed", stage: "query_paused", attempts: 1, createdAt: now, updatedAt: now },
        channelId: "libtv-image", baseUrl: "https://gw.example.com/v1", protocol: "libtv-image",
        pluginTask: { manifest: { id: "fixture" }, request: {}, taskId: "up-stale" },
    } as unknown as BrowserGenerationRecord);
    setConfig(pluginConfig({ ...imageChannel, baseUrl: "https://other.example/v1" }, "libtv/lib-image-2.5-s"));
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return new Response(); }) as typeof fetch;
    const blocked = await queryBrowserGeneration(id);
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toContain("原渠道已变更");
    expect(requests).toBe(0);
});
