import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import axios from "axios";
import localforage from "localforage";
import { useUserStore } from "../src/stores/use-user-store";
import * as userScope from "../src/lib/user-scope";
import * as pluginCatalog from "../src/services/api/plugin-catalog";
import { resetBrowserProtocolBridge } from "../src/services/api/browser-protocol";
import * as imageStorage from "../src/services/image-storage";
import { channelRequest } from "../src/services/api/custom-channel-relay";
import { fetchChannelModels, fetchImageModels } from "../src/services/api/image-models";
import { createModelChannel, defaultConfig, encodeChannelModel, resolveModelRequestConfig, useConfigStore } from "../src/stores/use-config-store";
import { listBrowserGenerations, readBrowserGeneration, writeBrowserGeneration } from "../src/services/browser-generation-store";
import { queryBrowserGeneration, submitBrowserGeneration } from "../src/services/browser-generation-runner";
import { listGenerationTasks } from "../src/services/api/task-center";
import { backendProviderConfig, prepareBackendGenerationTask } from "../src/services/api/generation-task";

const originalFetch = globalThis.fetch;
const originalUser = useUserStore.getState();
const originalConfig = useConfigStore.getState().config;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let records = new Map<string, unknown>();
let restores: Array<{ mockRestore(): void }> = [];
const channel = createModelChannel({ id: "personal", scope: "user", apiFormat: "openai", baseUrl: "https://personal.example/v1", apiKey: "synthetic-private-key", models: ["shared"], interfaceType: "chat-completion" });
const config = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "shared") };

beforeEach(() => {
    records = new Map();
    restores = [
        spyOn(localforage, "getItem").mockImplementation(async (key) => structuredClone(records.get(key) ?? null)),
        spyOn(localforage, "setItem").mockImplementation(async (key, value) => { records.set(key, structuredClone(value)); return value; }),
        spyOn(localforage, "iterate").mockImplementation(async (callback) => { for (const [key, value] of records) callback(structuredClone(value), key, 0); }),
    ];
    const held = new Set<string>();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
        request: async (name: string, run: () => unknown) => { held.add(name); try { return await run(); } finally { held.delete(name); } },
        query: async () => ({ held: [...held].map((name) => ({ name })), pending: [] }),
    } } });
    useUserStore.setState({ user: null, hydrated: true });
    useConfigStore.setState({ config });
});
afterEach(() => {
    for (const restore of [...restores].reverse()) restore.mockRestore();
    useUserStore.setState(originalUser);
    useConfigStore.setState({ config: originalConfig });
    globalThis.fetch = originalFetch;
    resetBrowserProtocolBridge();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else Reflect.deleteProperty(globalThis, "navigator");
});

async function settled(id: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const { task } = await readBrowserGeneration(id);
        if (task.status === "succeeded" || task.status === "failed") return task;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("Browser execution did not settle");
}

test("personal transport omits session credentials and proxy headers; system transport keeps its route", () => {
    const personal = resolveModelRequestConfig(config, config.model);
    const request = channelRequest(personal, "https://personal.example/v1/chat/completions", { "X-Canvas-Scene": "text", Cookie: "session=private" });
    expect(request.url).toBe("https://personal.example/v1/chat/completions");
    expect(request.credentials).toBe("omit");
    expect(request.headers.authorization).toBe("Bearer synthetic-private-key");
    expect(request.headers).not.toHaveProperty("x-canvas-scene");
    expect(request.headers).not.toHaveProperty("cookie");
    const system = channelRequest({ ...personal, channelScope: "system" }, request.url);
    expect(system.url).toEndWith("/ai/custom");
    expect(system.credentials).toBe("include");
    expect(() => channelRequest(personal, "https://other.example/v1/chat/completions")).toThrow("超出");
    expect(() => channelRequest({ ...personal, declarativePlugin: true, headers: [{ name: "Authorization", value: "override" }] }, request.url)).toThrow("系统管理");
    expect(() => channelRequest({ ...personal, baseUrl: "https://name:pass@personal.example/v1" }, request.url)).toThrow("userinfo");
    expect(() => channelRequest({ ...personal, interfaceType: "gemini-image" }, request.url)).toThrow("仅支持");
});

/** 真实结构的 v2 manifest：鉴权只由 catalog 声明的 auth 决定（与 Go HeaderAuth 同一份规则）。 */
function pluginManifest(providerId: string, capability: "image" | "video", auth?: Record<string, string>) {
    return {
        apiVersion: "yingce.plugin/v2",
        metadata: { id: "dreamina-cli", name: "Dreamina CLI", version: "1.2.0", vendor: "yingce", enabled: true },
        contributes: {
            providers: [
                {
                    id: providerId,
                    label: "Dreamina",
                    capabilities: [capability],
                    scopes: ["user.custom-channel"],
                    auth,
                    create: { method: "POST", path: "{{model}}", contentType: "application/json" },
                },
            ],
        },
    };
}

/** 共享 Go WASM 鉴权的替身：只按 manifest 声明的 auth 投影请求头，不在测试里复刻业务判定。 */
function sharedAuthBridge() {
    const calls: Array<Record<string, unknown>> = [];
    globalThis.yingceBrowserProtocol = (input: string) => {
        const call = JSON.parse(input) as {
            op?: string;
            manifest?: { contributes?: { providers?: Array<{ auth?: Record<string, string> }> } };
            credentials?: { apiKey?: string };
            spec?: { method?: string; path?: string };
        };
        calls.push(call as unknown as Record<string, unknown>);
        if (call.op !== "prepareHTTP") return JSON.stringify({ ok: false, error: `unexpected op ${call.op}` });
        const auth = call.manifest?.contributes?.providers?.[0]?.auth || {};
        const apiKey = call.credentials?.apiKey || "";
        const headers: Array<{ name: string; value: string }> = [];
        switch (String(auth.type || "").toLowerCase()) {
            case "none":
                break;
            case "bearer":
                headers.push({ name: auth.header || "Authorization", value: `${auth.prefix || "Bearer "}${apiKey}` });
                break;
            case "header":
            case "api-key":
                headers.push({ name: auth.header, value: `${auth.prefix || ""}${apiKey}` });
                break;
            case "basic":
                headers.push({ name: "Authorization", value: `Basic ${btoa(`${auth.username || apiKey}:`)}` });
                break;
            default:
                headers.push({ name: "Authorization", value: `Bearer ${apiKey}` });
        }
        return JSON.stringify({ ok: true, data: { headers, formValues: [] } });
    };
    return calls;
}

function stubPluginCatalog(state: { providers: Array<Record<string, unknown>>; failure?: string }) {
    const requests: Array<{ scope?: string; capability?: string }> = [];
    restores.push(spyOn(pluginCatalog, "fetchPluginProviderCatalog").mockImplementation((async (scope: string, capability?: string) => {
        requests.push({ scope, capability });
        if (state.failure) throw new Error(state.failure);
        return state.providers.filter((provider) => !capability || provider.capability === capability) as never;
    }) as never));
    return requests;
}

function stubModelRequest(payload: unknown = { data: [{ id: "list-model" }] }) {
    const requests: Array<Record<string, unknown>> = [];
    restores.push(spyOn(axios, "request").mockImplementation(async (input) => {
        requests.push(input as unknown as Record<string, unknown>);
        return { data: payload } as never;
    }));
    return requests;
}

function personalModelConfig(interfaceType: string) {
    return { baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: "openai" as const, channelScope: "user" as const, interfaceType };
}

test("personal model discovery forwards the manifest auth produced by the shared Go rules", async () => {
    const bridge = sharedAuthBridge();
    const catalog = stubPluginCatalog({
        providers: [
            { value: "dreamina-cli-image", capability: "image", browserManifest: pluginManifest("dreamina-cli-image", "image", { type: "header", field: "apiKey", header: "X-Api-Key" }) },
            { value: "dreamina-cli-video", capability: "video", browserManifest: pluginManifest("dreamina-cli-video", "video", { type: "none" }) },
        ],
    });
    const requests = stubModelRequest({ data: [{ id: "image-model" }] });

    await expect(fetchImageModels(personalModelConfig("dreamina-cli-image"))).resolves.toEqual(["image-model"]);
    expect(catalog[0]).toEqual({ scope: "user.custom-channel", capability: "image" });
    expect(requests[0]).toMatchObject({ method: "get", url: "https://personal.example/v1/models", withCredentials: false, headers: { "x-api-key": "synthetic-private-key" } });
    expect(requests[0]!.headers).not.toHaveProperty("authorization");

    // 只声明视频能力的插件同样可以拉模型目录；manifest 声明 none 时不夹带任何凭据，也不回退 Bearer。
    await expect(fetchImageModels(personalModelConfig("dreamina-cli-video"))).resolves.toEqual(["image-model"]);
    expect(catalog.map((item) => item.capability)).toEqual(["image", "image", "video"]);
    expect(requests[1]).toMatchObject({ url: "https://personal.example/v1/models", withCredentials: false, headers: {} });
    expect(requests[1]!.headers).not.toHaveProperty("authorization");

    const prepared = bridge.filter((call) => call.op === "prepareHTTP");
    expect(prepared.length).toBe(2);
    expect(prepared[0]).toMatchObject({ credentials: { apiKey: "synthetic-private-key" }, spec: { method: "GET", path: "/models" } });
});

test("default and basic manifest auth also come from the shared rules instead of a hardcoded Bearer", async () => {
    sharedAuthBridge();
    stubPluginCatalog({
        providers: [
            { value: "dreamina-cli-image", capability: "image", browserManifest: pluginManifest("dreamina-cli-image", "image") },
            { value: "dreamina-cli-basic", capability: "image", browserManifest: pluginManifest("dreamina-cli-basic", "image", { type: "basic", passwordField: "apiKey" }) },
        ],
    });
    const requests = stubModelRequest({ data: [{ id: "image-model" }] });

    await expect(fetchImageModels(personalModelConfig("dreamina-cli-image"))).resolves.toEqual(["image-model"]);
    expect(requests[0]!.headers).toMatchObject({ authorization: "Bearer synthetic-private-key" });

    await expect(fetchImageModels(personalModelConfig("dreamina-cli-basic"))).resolves.toEqual(["image-model"]);
    // image-models 只拿到 apiKey：Basic 凭据串只可能来自共享 Go 规则，而不是调用方硬编码的 Bearer。
    expect(requests[1]!.headers).toMatchObject({ authorization: `Basic ${btoa("synthetic-private-key:")}` });
});

test("text-only, uninstalled and non-browser plugin protocols stay blocked for personal model discovery", async () => {
    const state: { providers: Array<Record<string, unknown>> } = { providers: [{ value: "qcreate-cli-text", capability: "text", browserManifest: pluginManifest("qcreate-cli-text", "image") }] };
    const catalog = stubPluginCatalog(state);
    const requests = stubModelRequest();

    // 只声明 text 能力：媒体能力目录里查不到，不能当成图片/视频插件放行。
    await expect(fetchImageModels(personalModelConfig("qcreate-cli-text"))).rejects.toThrow("当前渠道未提供图片或视频能力的声明式插件");
    expect(catalog.map((item) => item.capability)).toEqual(["image", "video"]);

    state.providers.length = 0;
    await expect(fetchImageModels(personalModelConfig("qcreate-cli-image"))).rejects.toThrow("当前渠道未提供图片或视频能力的声明式插件");

    // 目录里有同名 provider 但没有 browserManifest：仍不是可执行的媒体协议。
    state.providers.push({ value: "qcreate-cli-image", capability: "image" });
    await expect(fetchImageModels(personalModelConfig("qcreate-cli-image"))).rejects.toThrow("当前渠道未提供图片或视频能力的声明式插件");
    expect(requests).toHaveLength(0);
});

test("standard OpenAI protocols keep Bearer when the catalog has no same-name plugin or is unreachable", async () => {
    const state: { providers: Array<Record<string, unknown>>; failure?: string } = { providers: [] };
    const catalog = stubPluginCatalog(state);
    const requests = stubModelRequest({ data: [{ id: "gpt-image" }] });

    await expect(fetchImageModels(personalModelConfig("openai-image"))).resolves.toEqual(["gpt-image"]);
    expect(catalog.map((item) => item.capability)).toEqual(["image", "video"]);
    expect(requests[0]).toMatchObject({ url: "https://personal.example/v1/models", withCredentials: false, headers: { authorization: "Bearer synthetic-private-key" } });

    // 内置标准协议可按既有行为降级；未知协议不能因目录故障被放行。
    state.failure = "catalog unreachable";
    await expect(fetchImageModels(personalModelConfig("openai-video"))).resolves.toEqual(["gpt-image"]);
    await expect(fetchImageModels(personalModelConfig("libtv-image"))).rejects.toThrow("catalog unreachable");
    expect(requests).toHaveLength(2);
});

test("a catalog plugin shadowing the openai-image protocol owns model discovery auth", async () => {
    sharedAuthBridge();
    stubPluginCatalog({ providers: [{ value: "openai-image", capability: "image", browserManifest: pluginManifest("openai-image", "image", { type: "header", field: "apiKey", header: "X-Api-Key" }) }] });
    const requests = stubModelRequest({ data: [{ id: "gpt-image" }] });

    await expect(fetchImageModels(personalModelConfig("openai-image"))).resolves.toEqual(["gpt-image"]);
    expect(requests[0]!.headers).toMatchObject({ "x-api-key": "synthetic-private-key" });
    expect(requests[0]!.headers).not.toHaveProperty("authorization");
});

test("system and Gemini channels never consult the plugin catalog", async () => {
    restores.push(spyOn(pluginCatalog, "fetchPluginProviderCatalog").mockImplementation(async () => { throw new Error("该渠道不应查询插件目录"); }));
    restores.push(spyOn(axios, "request").mockImplementation(async (input) => {
        // 系统渠道统一走 /ai/custom，靠后端代取声明的上游格式区分 OpenAI 与 Gemini 目录。
        const headers = ((input as { headers?: Record<string, string> }).headers || {});
        return { data: headers["x-canvas-upstream-format"] === "gemini" ? { models: [{ name: "models/gemini-2.5-flash" }] } : { data: [{ id: "shared" }] } } as never;
    }));

    await expect(fetchImageModels({ ...personalModelConfig("dreamina-cli-video"), channelScope: "system" })).resolves.toEqual(["shared"]);
    // 个人渠道的 Gemini 本来就不允许直连，这里只看系统 Gemini 不查插件目录。
    await expect(fetchImageModels({ ...personalModelConfig("dreamina-cli-video"), channelScope: "system", apiFormat: "gemini" })).resolves.toEqual(["gemini-2.5-flash"]);
});

test("channel identity cannot drift to a different channel offering the same model", async () => {
    const other = createModelChannel({ ...channel, id: "other" });
    expect(() => resolveModelRequestConfig({ ...config, channels: [other] }, config.model)).toThrow("原模型渠道");
    expect(() => resolveModelRequestConfig({ ...config, channels: [channel, other] }, "shared")).toThrow("同名模型");
    expect(resolveModelRequestConfig({ ...config, channels: [channel, other] }, config.model).requestChannelId).toBe("personal");
    expect(() => backendProviderConfig(config, "text")).toThrow("密钥");
    await expect(prepareBackendGenerationTask({ config, mode: "text", prompt: "Hello" })).rejects.toThrow("浏览器执行");
});

test("even a caller requesting backend model discovery cannot upload personal credentials", async () => {
    // 个人 OpenAI 渠道即使走本地拉取也只看目录里有没有同名插件；这里目录为空，沿用内置 Bearer。
    stubPluginCatalog({ providers: [] });
    let seen = "";
    restores.push(spyOn(axios, "request").mockImplementation(async (request) => { seen = request.url || ""; expect(request.withCredentials).toBe(false); return { data: { data: [{ id: "shared" }] } } as never; }));
    expect((await fetchChannelModels(channel, true)).models).toEqual(["shared"]);
    expect(seen).toBe("https://personal.example/v1/models");
});

test("text is submitted once after a durable record and replay only reads local state", async () => {
    let posts = 0;
    globalThis.fetch = (async (url, options) => {
        posts++;
        expect(String(url)).toBe("https://personal.example/v1/chat/completions");
        expect(options?.credentials).toBe("omit");
        expect((await listBrowserGenerations()).length).toBe(1);
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const request = { config, mode: "text" as const, prompt: "Hello", clientOperationId: "once" };
    const first = await submitBrowserGeneration(request);
    expect((await settled(first.id)).status).toBe("succeeded");
    expect((await submitBrowserGeneration(request)).id).toBe(first.id);
    expect((await queryBrowserGeneration(first.id)).resultJson).toContain("OK");
    expect(posts).toBe(1);
    expect(JSON.stringify([...records.values()])).not.toContain("synthetic-private-key");
});

test("an uncertain submission never silently retries or falls back to server", async () => {
    let posts = 0;
    globalThis.fetch = (async () => { posts++; throw new TypeError("Failed to fetch"); }) as typeof fetch;
    const request = { config, mode: "text" as const, prompt: "Hello", clientOperationId: "unknown" };
    const task = await submitBrowserGeneration(request);
    expect((await settled(task.id)).stage).toBe("submission_unknown");
    await queryBrowserGeneration(task.id);
    await submitBrowserGeneration(request);
    expect(posts).toBe(1);
});

test("storage failure blocks provider submission", async () => {
    let posts = 0;
    globalThis.fetch = (async () => { posts++; return new Response(); }) as typeof fetch;
    restores.push(spyOn(localforage, "setItem").mockRejectedValueOnce(new Error("Quota exceeded")));
    await expect(submitBrowserGeneration({ config, mode: "text", prompt: "Hello" })).rejects.toThrow("Quota exceeded");
    expect(posts).toBe(0);
});

test("local task enumeration is scoped; refreshing a video reads its original handle with GET only", async () => {
    const task = { id: "browser:video", model: "shared", status: "failed" as const, type: "canvas_video", createdAt: "now", updatedAt: "now" };
    const videoChannel = { ...channel, interfaceType: "newapi" };
    useConfigStore.setState({ config: { ...config, channels: [videoChannel] } });
    const record = { task, channelId: channel.id, baseUrl: channel.baseUrl, protocol: "newapi", video: { id: "upstream-123", provider: "openai" as const, model: config.model } };
    await writeBrowserGeneration(record);
    records.set(userScope.scopedStorageKey("yingce:browser-generation:browser:other", "another-user"), { ...record, task: { ...task, id: "browser:other" } });
    expect((await listBrowserGenerations()).map((item) => item.id)).toEqual([task.id]);
    let gets = 0;
    restores.push(spyOn(axios, "request").mockImplementation(async (request) => { gets++; expect(request.method).toBe("get"); expect(request.url).toBe("https://personal.example/v1/videos/upstream-123"); return { data: { id: "upstream-123", status: "in_progress" } } as never; }));
    expect((await queryBrowserGeneration(task.id)).status).toBe("running");
    expect(gets).toBe(1);
});

test("image receipt survives download failure; recovery never resubmits generation", async () => {
    const blobs = new Map<string, Blob>();
    restores.push(spyOn(pluginCatalog, "fetchPluginProviderCatalog").mockResolvedValue([]));
    restores.push(spyOn(imageStorage, "setImageBlob").mockImplementation(async (key, blob) => { blobs.set(key, blob); return "blob:mock"; }));
    restores.push(spyOn(imageStorage, "getImageBlob").mockImplementation(async (key) => blobs.get(key) || null));
    const imageConfig = { ...config, channels: [{ ...channel, interfaceType: "openai-image" }] };
    useConfigStore.setState({ config: imageConfig });
    let posts = 0;
    restores.push(spyOn(axios, "request").mockImplementation(async (request) => {
        posts++;
        expect(request.method).toBe("post");
        expect(request.url).toBe("https://personal.example/v1/images/generations");
        return { data: { data: [{ url: "https://media.example/generated.png" }] } } as never;
    }));
    globalThis.fetch = (async () => { throw new TypeError("download interrupted"); }) as typeof fetch;
    const task = await submitBrowserGeneration({ config: imageConfig, mode: "image", prompt: "A tree", clientOperationId: "image-receipt" });
    expect((await settled(task.id)).canRecoverMedia).toBe(true);
    expect((await readBrowserGeneration(task.id)).pendingMedia?.sources).toEqual(["https://media.example/generated.png"]);
    globalThis.fetch = (async (url, options) => {
        expect(String(url)).toBe("https://media.example/generated.png");
        expect(options?.credentials).toBe("omit");
        return new Response(new Blob(["synthetic image bytes"], { type: "image/png" }));
    }) as typeof fetch;
    const recovered = await queryBrowserGeneration(task.id);
    expect(recovered.status).toBe("succeeded");
    expect(recovered.resultJson).toContain("image:guest:browser:image-receipt:0");
    expect((await readBrowserGeneration(task.id)).pendingMedia).toBeUndefined();
    expect(posts).toBe(1);
});

test("text image references are included inline without forwarding private resource URLs", async () => {
    let content: unknown;
    globalThis.fetch = (async (_url, options) => {
        content = JSON.parse(String(options?.body)).messages.at(-1).content;
        return new Response('data: {"choices":[{"delta":{"content":"A tree"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const dataUrl = "data:image/png;base64,c3ludGhldGlj";
    const task = await submitBrowserGeneration({ config, mode: "text", prompt: "Describe", referenceImages: [{ dataUrl }], clientOperationId: "text-image" });
    expect((await settled(task.id)).status).toBe("succeeded");
    expect(content).toEqual([{ type: "text", text: "Describe" }, { type: "image_url", image_url: { url: dataUrl } }]);
});

test("missing cross-tab mutual exclusion prevents any submission", async () => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    let posts = 0;
    globalThis.fetch = (async () => { posts++; return new Response(); }) as typeof fetch;
    await expect(submitBrowserGeneration({ config, mode: "text", prompt: "Hello" })).rejects.toThrow("跨标签");
    expect(posts).toBe(0);
});


test("a different tab changing the shared account cannot receive this tab's private task", async () => {
    useUserStore.setState({ user: { id: "account-A", username: "A", displayName: "A", role: "user", status: "active" }, hydrated: true });
    restores.push(spyOn(userScope, "getActiveUserScope").mockReturnValue("account-B"));
    let posts = 0;
    globalThis.fetch = (async () => { posts++; return new Response(); }) as typeof fetch;
    await expect(submitBrowserGeneration({ config, mode: "text", prompt: "account-A private prompt" })).rejects.toThrow("账号状态");
    await expect(listBrowserGenerations()).rejects.toThrow("账号状态");
    await expect(queryBrowserGeneration("browser:existing")).rejects.toThrow("账号状态");
    await expect(listGenerationTasks(30, undefined, { listBackend: async () => [] })).rejects.toThrow("账号状态");
    expect(posts).toBe(0);
    expect(records.size).toBe(0);
});

test("a completed task read cannot return private output after the account changes while IndexedDB is pending", async () => {
    let sharedScope = "guest";
    restores.push(spyOn(userScope, "getActiveUserScope").mockImplementation(() => sharedScope));
    let release!: (value: unknown) => void;
    restores.push(spyOn(localforage, "getItem").mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })));
    const reading = queryBrowserGeneration("browser:delayed");
    useUserStore.setState({ user: { id: "account-B", username: "B", displayName: "B", role: "user", status: "active" } });
    sharedScope = "account-B";
    release({ task: { id: "browser:delayed", status: "succeeded", prompt: "private prompt", resultJson: "private output" } });
    await expect(reading).rejects.toThrow("账号状态");
});

test("a delayed cross-tab lock query cannot return the previous account's running task", async () => {
    let sharedScope = "account-A";
    restores.push(spyOn(userScope, "getActiveUserScope").mockImplementation(() => sharedScope));
    useUserStore.setState({ user: { id: "account-A", username: "A", displayName: "A", role: "user", status: "active" } });
    const task = { id: "browser:locked", prompt: "account-A private prompt", model: "shared", status: "running" as const, type: "canvas_text", createdAt: "now", updatedAt: "now" };
    await writeBrowserGeneration({ task, channelId: channel.id, baseUrl: channel.baseUrl, protocol: "chat-completion" });
    let release!: (value: { held: Array<{ name: string }> }) => void;
    let queried!: () => void;
    const started = new Promise<void>((resolve) => { queried = resolve; });
    restores.push(spyOn(navigator.locks, "query").mockImplementation(() => { queried(); return new Promise((resolve) => { release = resolve; }); }));
    let requests = 0;
    globalThis.fetch = (async () => { requests++; throw new Error("No network allowed"); }) as typeof fetch;
    const reading = queryBrowserGeneration(task.id);
    await started;
    useUserStore.setState({ user: { id: "account-B", username: "B", displayName: "B", role: "user", status: "active" } });
    sharedScope = "account-B";
    release({ held: [{ name: userScope.scopedStorageKey("yingce:browser-generation:" + task.id, "account-A") }] });
    await expect(reading).rejects.toThrow("账号状态");
    expect(requests).toBe(0);
});

test("unloaded sessions and stale channel credentials block submission before persistence", async () => {
    let posts = 0;
    globalThis.fetch = (async () => { posts++; return new Response(); }) as typeof fetch;
    useUserStore.setState({ hydrated: false });
    await expect(submitBrowserGeneration({ config, mode: "text", prompt: "Hello" })).rejects.toThrow("账号状态");
    useUserStore.setState({ hydrated: true });
    useConfigStore.setState({ config: { ...config, channels: [{ ...channel, apiKey: "different-session-key" }] } });
    await expect(submitBrowserGeneration({ config, mode: "text", prompt: "Hello" })).rejects.toThrow("配置已变更");
    expect(posts).toBe(0);
    expect(records.size).toBe(0);
});
