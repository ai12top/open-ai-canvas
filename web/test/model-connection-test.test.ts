import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import localforage from "localforage";
import * as audioApi from "../src/services/api/audio";
import * as browserProtocol from "../src/services/api/browser-protocol";
import * as browserPlugin from "../src/services/api/browser-plugin";
import * as imageApi from "../src/services/api/image";
import * as taskCenter from "../src/services/api/task-center";
import * as imageStorage from "../src/services/image-storage";
import * as fileStorage from "../src/services/file-storage";
import * as runner from "../src/services/browser-generation-runner";
import { listBrowserGenerations, readBrowserGeneration } from "../src/services/browser-generation-store";
import { testChannelModelConnection } from "../src/lib/model-connection-test";
import { useUserStore } from "../src/stores/use-user-store";
import {
    createModelChannel,
    defaultConfig,
    encodeChannelModel,
    useConfigStore,
    type ModelCapability,
    type ModelChannel,
} from "../src/stores/use-config-store";

const MODEL = "test-image";
const PROMPT = "A simple gray circle on a white background.";

const originalFetch = globalThis.fetch;
const originalUser = useUserStore.getState();
const originalConfig = useConfigStore.getState().config;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

let records = new Map<string, unknown>();
let blobs = new Map<string, Blob>();
let restores: Array<{ mockRestore(): void }> = [];

type ChannelSpec = {
    id: string;
    interfaceType: string;
    protocol?: string;
    capability?: ModelCapability;
    scope?: "user" | "system";
    apiKey?: string;
    model?: string;
};

/** A channel shaped the way the admin UI saves it: protocol lives on the model cost. */
function channel(spec: ChannelSpec): ModelChannel {
    const model = spec.model || MODEL;
    return createModelChannel({
        id: spec.id,
        name: spec.id,
        scope: spec.scope || "user",
        apiFormat: "openai",
        baseUrl: "https://gw.example.com/v1",
        apiKey: spec.apiKey ?? "synthetic-key",
        models: [model],
        interfaceType: spec.interfaceType,
        modelCosts: [
            {
                model,
                capability: spec.capability || "image",
                protocol: spec.protocol || spec.interfaceType,
                billingMode: "fixed_request",
                unitPriceMicrocredits: 0,
            },
        ],
    });
}

function installStore(target: ModelChannel, model = MODEL) {
    const config = { ...defaultConfig, channels: [target], model: encodeChannelModel(target.id, model) };
    useConfigStore.setState({ config });
    return config;
}

function spy<T extends object, K extends keyof T>(target: T, key: K, impl: T[K]) {
    const created = spyOn(target, key).mockImplementation(impl as never);
    restores.push(created);
    return created as unknown as { mockImplementation(impl: T[K]): void; mockRestore(): void; mock: { calls: unknown[][] } };
}

function fail(target: object, key: string, message: string) {
    return spy(target as never, key as never, (async () => {
        throw new Error(message);
    }) as never);
}

beforeEach(() => {
    records = new Map();
    blobs = new Map();
    restores = [
        spy(localforage, "getItem", async (key: string) => structuredClone(records.get(key) ?? null)),
        spy(localforage, "setItem", async (key: string, value: unknown) => {
            records.set(key, structuredClone(value));
            return value;
        }),
        spy(localforage, "iterate", async (callback: (value: unknown, key: string, index: number) => void) => {
            for (const [key, value] of records) callback(structuredClone(value), key, 0);
        }),
        spy(imageStorage, "setImageBlob", async (key: string, blob: Blob) => {
            blobs.set(key, blob);
            return "blob:mock";
        }),
        spy(imageStorage, "getImageBlob", async (key: string) => blobs.get(key) || null),
        spy(fileStorage, "setMediaBlob", async (key: string, blob: Blob) => {
            blobs.set(key, blob);
            return "blob:mock";
        }),
        spy(fileStorage, "getMediaBlob", async (key: string) => blobs.get(key) || null),
    ];
    const held = new Set<string>();
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async (name: string, run: () => unknown) => {
                    held.add(name);
                    try {
                        return await run();
                    } finally {
                        held.delete(name);
                    }
                },
                query: async () => ({ held: [...held].map((name) => ({ name })), pending: [] }),
            },
        },
    });
    useUserStore.setState({ user: null, hydrated: true });
});
afterEach(() => {
    for (const restore of [...restores].reverse()) restore.mockRestore();
    useUserStore.setState(originalUser);
    useConfigStore.setState({ config: originalConfig });
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
});

// ---- the test panel itself: both personal image entries must use the runner ----

test("personal image channels submit through the runner whether or not the protocol name matches openai-image", async () => {
    const submitted: Array<Record<string, any>> = [];
    const returned: unknown[] = [];
    const waited: Array<{ id: string; options: unknown }> = [];
    spy(runner, "submitBrowserGeneration", (async (options: Record<string, any>) => {
        submitted.push(options);
        const task = { id: `browser:test-${submitted.length}`, status: "running", stage: "submitting" };
        returned.push(task);
        return task as never;
    }) as never);
    spy(taskCenter, "waitForGenerationTask", (async (id: string, options: unknown) => {
        waited.push({ id, options });
        return { id, status: "succeeded" } as never;
    }) as never);
    const builtin = fail(imageApi, "requestGeneration", "个人图像不应走内置 requestGeneration");
    const question = fail(imageApi, "requestImageQuestion", "个人图像不应走文本问答接口");

    const sameName = channel({ id: "openai-image", interfaceType: "openai-image" });
    const plugin = channel({ id: "libtv-image", interfaceType: "libtv-image" });

    expect(await testChannelModelConnection(sameName, MODEL, "image", "openai-image")).toBe("图片生成正常");
    expect(await testChannelModelConnection(plugin, MODEL, "image", "libtv-image")).toBe("图片生成正常");

    expect(builtin.mock.calls.length).toBe(0);
    expect(question.mock.calls.length).toBe(0);
    expect(submitted.length).toBe(2);
    expect(waited.length).toBe(2);

    [sameName, plugin].forEach((entry, index) => {
        const options = submitted[index];
        const encoded = encodeChannelModel(entry.id, MODEL);
        expect(options.mode).toBe("image");
        expect(options.prompt).toBe(PROMPT);
        expect(options.config.model).toBe(encoded);
        expect(options.config.channelMode).toBe("remote");
        expect(options.config.model).toBe(options.config.imageModel);
        // The channel (with the protocol cost the runner compares against) travels with the request.
        expect(options.config.channels.length).toBe(1);
        expect(options.config.channels[0].id).toBe(entry.id);
        expect(options.config.channels[0].scope).toBe("user");
        expect(options.config.channels[0].modelCosts[0]).toMatchObject({
            model: MODEL,
            capability: "image",
            protocol: entry.modelCosts![0].protocol,
        });
        expect(options.referenceImages).toBeUndefined();
        expect(options.mask).toBeUndefined();
        expect(waited[index].id).toBe(`browser:test-${index + 1}`);
        expect((waited[index].options as { initialTask?: unknown }).initialTask).toBe(returned[index]);
    });
});

test("system image channels keep the backend requestGeneration path", async () => {
    const submit = fail(runner, "submitBrowserGeneration", "系统图像不应走浏览器 runner");
    const wait = fail(taskCenter, "waitForGenerationTask", "系统图像不应轮询本机任务");
    const prompts: string[] = [];
    const configs: unknown[] = [];
    spy(imageApi, "requestGeneration", (async (config: unknown, prompt: string) => {
        configs.push(config);
        prompts.push(prompt);
        return [] as never;
    }) as never);

    const system = channel({ id: "system-image", interfaceType: "openai-image", scope: "system", apiKey: "system-key" });
    expect(await testChannelModelConnection(system, MODEL, "image", "openai-image")).toBe("图片生成正常");
    expect(prompts).toEqual([PROMPT]);
    expect(configs.length).toBe(1);
    expect(submit.mock.calls.length).toBe(0);
    expect(wait.mock.calls.length).toBe(0);
});

test("personal text and audio keep their original request paths and protocol guard", async () => {
    const submit = fail(runner, "submitBrowserGeneration", "个人文本/音频不应走浏览器 runner");
    const asked: Array<unknown> = [];
    spy(imageApi, "requestImageQuestion", (async (_config: unknown, messages: unknown) => {
        asked.push(messages);
        return "OK";
    }) as never);
    const audio = spy(audioApi, "requestAudioGeneration", (async () => new Blob(["audio"], { type: "audio/wav" })) as never);

    const text = channel({ id: "personal-text", interfaceType: "chat-completion", capability: "text" });
    expect(await testChannelModelConnection(text, MODEL, "text", "chat-completion")).toBe("文本响应正常");
    expect(asked[0]).toEqual([{ role: "user", content: "Reply with OK." }]);

    const audioChannel = channel({ id: "personal-audio", interfaceType: "openai-audio", capability: "audio" });
    expect(await testChannelModelConnection(audioChannel, MODEL, "audio", "openai-audio")).toBe("音频生成正常");
    expect(audio.mock.calls.length).toBe(1);

    const pluginText = channel({ id: "plugin-text", interfaceType: "libtv-image", capability: "text" });
    await expect(testChannelModelConnection(pluginText, MODEL, "text", "libtv-image")).rejects.toThrow("仅支持标准 OpenAI");
    expect(asked.length).toBe(1);
    expect(submit.mock.calls.length).toBe(0);
});

test("errors from the image entries surface instead of a success message", async () => {
    const submit = spy(runner, "submitBrowserGeneration", (async () => {
        throw new Error("插件鉴权失败");
    }) as never);
    const wait = spy(taskCenter, "waitForGenerationTask", (async () => {
        throw new Error("上游任务失败");
    }) as never);
    const builtin = spy(imageApi, "requestGeneration", (async () => {
        throw new Error("内置图片接口 500");
    }) as never);

    const personal = channel({ id: "openai-image", interfaceType: "openai-image" });
    await expect(testChannelModelConnection(personal, MODEL, "image", "openai-image")).rejects.toThrow("插件鉴权失败");
    expect(wait.mock.calls.length).toBe(0);

    submit.mockImplementation((async () => ({ id: "browser:test-wait", status: "running" })) as never);
    await expect(testChannelModelConnection(personal, MODEL, "image", "openai-image")).rejects.toThrow("上游任务失败");

    const system = channel({ id: "system-image", interfaceType: "openai-image", scope: "system" });
    await expect(testChannelModelConnection(system, MODEL, "image", "openai-image")).rejects.toThrow("内置图片接口 500");
    expect(builtin.mock.calls.length).toBe(1);
});

test("missing endpoint or key fails before any request is made", async () => {
    const submit = fail(runner, "submitBrowserGeneration", "缺少配置不应提交");
    const builtin = fail(imageApi, "requestGeneration", "缺少配置不应请求");

    await expect(testChannelModelConnection({ ...channel({ id: "openai-image", interfaceType: "openai-image" }), baseUrl: "  " }, MODEL, "image", "openai-image")).rejects.toThrow("请先填写 Base URL");
    await expect(testChannelModelConnection({ ...channel({ id: "openai-image", interfaceType: "openai-image" }), apiKey: "" }, MODEL, "image", "openai-image")).rejects.toThrow("请先填写 API Key");
    expect(submit.mock.calls.length).toBe(0);
    expect(builtin.mock.calls.length).toBe(0);
});

// ---- the real runner: composition with catalog/preflight and the live store ----

async function settle(taskId: string) {
    for (let attempt = 0; attempt < 600; attempt++) {
        const { task } = await readBrowserGeneration(taskId);
        if (task.status === "succeeded" || task.status === "failed") return task;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("runner 未在预期时间内完成任务");
}

test("a personal openai-image channel shadowed by a catalog plugin still runs through the real runner", async () => {
    const pluginChannel = channel({ id: "openai-image", interfaceType: "openai-image" });
    const config = installStore(pluginChannel);

    // Local WASM bridge boundary: size normalization is a pure call, and the plugin HTTP spec is the fixture's job.
    const manifest = { id: "fixture", contributes: { providers: [{ id: "openai-image" }] } } as unknown as browserPlugin.BrowserPluginManifest;
    spy(browserProtocol, "callBrowserProtocol", (async (call: { op?: string; request?: unknown }) => {
        if (call?.op === "normalizeImage") return call.request;
        if (call?.op === "prepareHTTP") return { headers: [], formValues: [] };
        throw new Error(`意外的浏览器协议调用：${call?.op}`);
    }) as never);
    const calls = { manifest: 0, create: 0, poll: 0 };
    spy(browserPlugin, "resolveBrowserPlugin", (async () => {
        calls.manifest += 1;
        return manifest;
    }) as never);
    spy(browserPlugin, "createBrowserPluginTask", (async () => {
        calls.create += 1;
        return { status: "succeeded" as const, taskId: "up-shadow", result: { images: [{ url: "https://gw.example.com/v1/files/out.png" }] } };
    }) as never);
    const poll = fail(browserPlugin, "pollBrowserPluginTask", "同步完成的插件任务不应轮询");
    const builtin = fail(imageApi, "requestGeneration", "同名插件不应回落到内置图片接口");
    globalThis.fetch = (async () => new Response(new Blob(["synthetic png"], { type: "image/png" }))) as unknown as typeof fetch;

    const waited: string[] = [];
    spy(taskCenter, "waitForGenerationTask", (async (id: string) => {
        waited.push(id);
        return await settle(id);
    }) as never);

    expect(await testChannelModelConnection(pluginChannel, MODEL, "image", "openai-image")).toBe("图片生成正常");

    expect(calls.manifest).toBe(1);
    expect(calls.create).toBe(1);
    expect(poll.mock.calls.length).toBe(0);
    expect(builtin.mock.calls.length).toBe(0);
    expect(waited.length).toBe(1);
    const { task } = await readBrowserGeneration(waited[0]);
    expect(task.status).toBe("succeeded");
    expect(task.executionSource).toBe("browser");
    expect(task.resultJson).toContain(":0");
    // The panel test never rewrites the store the runner read.
    expect(useConfigStore.getState().config).toBe(config);
});

test("a test config that drifted from the live store stops the runner without touching store or records", async () => {
    spy(browserPlugin, "resolveBrowserPlugin", (async () => undefined) as never);
    const builtin = fail(imageApi, "requestGeneration", "配置不一致不应请求上游");
    const wait = fail(taskCenter, "waitForGenerationTask", "配置不一致不应轮询");

    // The store now points this model at another standard protocol: the runner names the drift.
    const live = channel({ id: "openai-image", interfaceType: "chat-completion" });
    const liveConfig = installStore(live);
    const stale = channel({ id: "openai-image", interfaceType: "openai-image" });
    await expect(testChannelModelConnection(stale, MODEL, "image", "openai-image")).rejects.toThrow("原渠道已变更");
    expect(useConfigStore.getState().config).toBe(liveConfig);
    expect(await listBrowserGenerations()).toEqual([]);
    expect(records.size).toBe(0);

    // Drifting to a declarative plugin protocol is refused by the personal-OpenAI guard first.
    installStore(channel({ id: "openai-image", interfaceType: "libtv-image" }));
    const pluginConfig = useConfigStore.getState().config;
    await expect(testChannelModelConnection(stale, MODEL, "image", "openai-image")).rejects.toThrow("仅支持标准 OpenAI");
    expect(useConfigStore.getState().config).toBe(pluginConfig);
    expect(records.size).toBe(0);

    // Same channel identity, rotated credentials: the preflight refuses to spend on the wrong key.
    installStore(channel({ id: "openai-image", interfaceType: "openai-image", apiKey: "current-key" }));
    const rotated = channel({ id: "openai-image", interfaceType: "openai-image", apiKey: "rotated-key" });
    const keyConfig = useConfigStore.getState().config;
    await expect(testChannelModelConnection(rotated, MODEL, "image", "openai-image")).rejects.toThrow("个人渠道配置已变更");
    expect(useConfigStore.getState().config).toBe(keyConfig);
    expect(records.size).toBe(0);
    expect(builtin.mock.calls.length).toBe(0);
    expect(wait.mock.calls.length).toBe(0);
});
