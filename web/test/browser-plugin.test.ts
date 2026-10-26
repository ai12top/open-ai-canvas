import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import axios from "axios";

import type { ChannelTransportConfig } from "../src/services/api/channel-transport";
import { apiClient } from "../src/services/api/request";
import { createBrowserPluginTask, fetchBrowserPluginResult, resolveBrowserPlugin, pluginDownloadRequest, pollBrowserPluginTask, type BrowserPluginHandle, type BrowserPluginManifest } from "../src/services/api/browser-plugin";
import { resetBrowserProtocolBridge } from "../src/services/api/browser-protocol";
import { channelRequest } from "../src/services/api/custom-channel-relay";

const originalAxiosRequest = axios.request;
const originalApiRequest = apiClient.request;
const originalFetch = globalThis.fetch;

type BridgeCall = Record<string, unknown>;

const manifest: BrowserPluginManifest = {
    apiVersion: "yingce.plugin/v2",
    id: "gateway-plugin",
    contributes: { providers: [{ id: "gw-image", auth: { type: "bearer" } }] },
};

const config: ChannelTransportConfig = {
    baseUrl: "https://gw.example.com/v1",
    apiKey: "sk-live",
    apiFormat: "openai",
    channelScope: "user",
    // 不是 PERSONAL_OPENAI_PROTOCOLS 里的标准协议：只有 declarativePlugin 标记才放行。
    interfaceType: "gw-image",
};

beforeEach(() => {
    apiClient.request = originalApiRequest;
    axios.request = originalAxiosRequest;
    globalThis.yingceBrowserProtocol = () => JSON.stringify({ ok: false, error: "unexpected bridge call" });
});

afterEach(() => {
    resetBrowserProtocolBridge();
    axios.request = originalAxiosRequest;
    apiClient.request = originalApiRequest;
    globalThis.fetch = originalFetch;
});

function bridgeReplies(replies: Record<string, unknown>) {
    globalThis.yingceBrowserProtocol = (input: string) => {
        const call = JSON.parse(input) as BridgeCall;
        const op = String(call.op);
        if (!(op in replies)) return JSON.stringify({ ok: false, error: `unexpected op ${op}` });
        return JSON.stringify({ ok: true, data: replies[op] });
    };
}

function stubAxios(response: unknown = { data: {} }) {
    const calls: Array<Record<string, unknown>> = [];
    axios.request = (async (request: Record<string, unknown>) => {
        calls.push(request);
        return response;
    }) as typeof axios.request;
    return calls;
}

function stubCatalog(item: Record<string, unknown>) {
    const requests: Array<Record<string, unknown>> = [];
    apiClient.request = (async (request: Record<string, unknown>) => {
        requests.push(request);
        return { data: { code: 0, data: { providers: [{ id: "gw-image", version: "1.0.0", name: "Gateway", vendor: "gw", categories: ["image"], scopes: ["user.custom-channel"], enabled: true, ...item }] } } };
    }) as typeof apiClient.request;
    return requests;
}

describe("browser plugin catalog and manifest loading", () => {
    test("loads the catalog browserManifest after Go describe confirms create", async () => {
        const catalogRequests = stubCatalog({ browserManifest: manifest });
        bridgeReplies({ describe: { providerId: "gw-image", operations: { create: true, poll: true } } });

        const loaded = await resolveBrowserPlugin(config, "image");

        expect(loaded).toEqual(manifest);
        expect(catalogRequests[0]).toMatchObject({ method: "get", params: { scope: "user.custom-channel", capability: "image" } });
    });

    test("reports the catalog unsupported reason instead of falling back to a server channel", async () => {
        stubCatalog({ browserUnsupportedReason: 'browser execution does not support auth "sigv4"' });
        await expect(resolveBrowserPlugin(config, "image")).rejects.toThrow("browser execution does not support auth");
    });

    test("requires a user-scoped personal channel", async () => {
        await expect(resolveBrowserPlugin({ ...config, channelScope: "system" }, "image")).rejects.toThrow("个人渠道");
    });

    test("rejects a provider that is missing from the capability catalog", async () => {
        stubCatalog({ browserManifest: manifest });
        await expect(resolveBrowserPlugin({ ...config, interfaceType: "other-provider" }, "image")).rejects.toThrow("未提供图片能力");
    });

    test("keeps the built-in OpenAI protocol when the catalog cannot be read", async () => {
        apiClient.request = (async () => { throw new Error("catalog unreachable"); }) as typeof apiClient.request;
        await expect(resolveBrowserPlugin({ ...config, interfaceType: "openai-image" }, "image")).resolves.toBeUndefined();
    });

    test("falls back to the built-in protocol when the same-name provider is not browser executable", async () => {
        // 刻意取舍：同名条目只给了 browserUnsupportedReason 时不抢内置协议，避免把既有 OpenAI 渠道整个打断；
        // 插件不可执行的提示因此只在非同名插件上出现。
        stubCatalog({ id: "openai-image", browserUnsupportedReason: 'browser execution does not support auth "sigv4"' });
        await expect(resolveBrowserPlugin({ ...config, interfaceType: "openai-image" }, "image")).resolves.toBeUndefined();
    });

    test("prefers the catalog plugin when its provider id shadows a built-in protocol name", async () => {
        stubCatalog({ id: "openai-image", browserManifest: manifest });
        bridgeReplies({ describe: { providerId: "openai-image", operations: { create: true, poll: true } } });
        await expect(resolveBrowserPlugin({ ...config, interfaceType: "openai-image" }, "image")).resolves.toEqual(manifest);
    });
});

describe("browser plugin task execution", () => {
    test("creates a task through the shared transport with manifest auth and prefix join", async () => {
        bridgeReplies({
            buildCreate: { method: "POST", path: "/v1/images/generations", contentType: "application/json", headers: { "x-protocol": "v2" }, body: { prompt: "cat", model: "gw-image-1" }, auth: { type: "bearer" } },
            parseCreate: { status: "succeeded", result: { images: [{ url: "https://cdn.example.com/a.png" }] } },
        });
        const calls = stubAxios({ data: { created: 1 } });
        const controller = new AbortController();

        const result = await createBrowserPluginTask(config, manifest, { capability: "image", model: "gw-image-1", prompt: "cat" }, controller.signal);

        expect(result.status).toBe("succeeded");
        expect(result.result?.images?.[0]?.url).toBe("https://cdn.example.com/a.png");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            method: "post",
            url: "https://gw.example.com/v1/images/generations",
            headers: expect.objectContaining({ authorization: "Bearer sk-live", "x-protocol": "v2", "content-type": "application/json" }),
            withCredentials: false,
            signal: controller.signal,
            data: { prompt: "cat", model: "gw-image-1" },
        });
    });

    test("polls from the persisted handle, unpacks query pairs and never re-reads the catalog", async () => {
        let catalogRead = 0;
        apiClient.request = (async () => {
            catalogRead += 1;
            return { data: { code: 0, data: { providers: [] } } };
        }) as typeof apiClient.request;
        bridgeReplies({
            buildPoll: { method: "GET", path: "/v1/tasks/task-9", query: { cursor: ["a", "b"] }, auth: { type: "header", header: "x-api-key", prefix: "Token " } },
            parsePoll: { status: "processing" },
        });
        const calls = stubAxios({ data: { state: "running" } });
        const handle: BrowserPluginHandle = { manifest, request: { model: "gw-image-1" }, taskId: "task-9" };

        const result = await pollBrowserPluginTask(config, handle);

        expect(result).toEqual({ status: "processing", taskId: "task-9", result: undefined, message: undefined });
        expect(catalogRead).toBe(0);
        expect(calls[0]).toMatchObject({ method: "get", url: "https://gw.example.com/v1/tasks/task-9?cursor=a&cursor=b", withCredentials: false, data: undefined });
        // manifest 鉴权为 header 时不能偷偷再补一个默认 Bearer。
        expect(calls[0]?.headers).toMatchObject({ "x-api-key": "Token sk-live" });
        expect((calls[0]?.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    test("creates originPath tasks from the channel origin instead of the Base prefix", async () => {
        bridgeReplies({
            buildCreate: { method: "POST", path: "/api/generate", originPath: true, contentType: "application/json", body: { prompt: "cat" } },
            parseCreate: { taskId: "task-2", status: "processing" },
        });
        const calls = stubAxios({ data: { ok: true } });

        await createBrowserPluginTask(config, manifest, { capability: "image", model: "gw-image-1", prompt: "cat" });

        expect(calls[0]?.url).toBe("https://gw.example.com/api/generate");
    });

    test("posts multipart file references from dataUrl without a manual content type", async () => {
        bridgeReplies({
            buildCreate: {
                method: "POST",
                path: "/uploads",
                contentType: "multipart/form-data",
                body: { model: "gw-image-1" },
                files: [{ name: "image", reference: { dataUrl: "data:image/png;base64,cG5n", name: "ref.png", mimeType: "image/png" } }],
            },
            parseCreate: { taskId: "task-1", status: "processing" },
        });
        const calls = stubAxios({ data: { accepted: true } });
        globalThis.fetch = (async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), { status: 200 })) as typeof fetch;

        const result = await createBrowserPluginTask(config, manifest, { capability: "image", model: "gw-image-1", prompt: "cat" });

        expect(result).toMatchObject({ status: "processing", taskId: "task-1" });
        const form = calls[0]?.data as FormData;
        expect(form).toBeInstanceOf(FormData);
        expect(form.get("model")).toBe("gw-image-1");
        expect((form.get("image") as File).name).toBe("ref.png");
        expect((calls[0]?.headers as Record<string, string>)["content-type"]).toBeUndefined();
        expect((calls[0]?.headers as Record<string, string>).authorization).toBe("Bearer sk-live");
    });

    test("keeps the original bridge error text", async () => {
        globalThis.yingceBrowserProtocol = () => JSON.stringify({ ok: false, error: "build browser provider: load browser manifest: unknown auth" });
        await expect(createBrowserPluginTask(config, manifest, { capability: "image" })).rejects.toThrow("build browser provider: load browser manifest: unknown auth");
    });
});

describe("browser plugin media download", () => {
    test("applies manifest auth only on the selected channel origin", () => {
        const sameOrigin = pluginDownloadRequest(config, manifest, "https://gw.example.com/v1/files/a.png");
        expect(sameOrigin).toMatchObject({ credentials: "omit", headers: { authorization: "Bearer sk-live" } });
        const thirdParty = pluginDownloadRequest(config, manifest, "https://cdn.example.com/a.png");
        expect(thirdParty).toEqual({ url: "https://cdn.example.com/a.png", headers: {}, credentials: "omit" });
        // 同源但超出渠道路径：仍然是用户选中的主机，只借用鉴权头，不重定向。
        const outsideScope = pluginDownloadRequest(config, manifest, "https://gw.example.com/other/a.png");
        expect(outsideScope).toMatchObject({ url: "https://gw.example.com/other/a.png", credentials: "omit", headers: { authorization: "Bearer sk-live" } });
    });
});

function stubFetch(blob: Blob, status = 200, contentType = blob.type) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init || {} });
        return new Response(blob, { status, headers: contentType ? { "content-type": contentType } : {} });
    }) as typeof fetch;
    return calls;
}

const mediaManifest: BrowserPluginManifest = {
    apiVersion: "yingce.plugin/v2",
    id: "newapi-media-task-v1",
    contributes: {
        providers: [
            {
                id: "gw-image",
                auth: { type: "bearer" },
                // 官方 newapi-media-task-v1：成功态没有内联 URL，只声明独立 result 二进制端点。
                result: { method: "GET", path: "/files/{{taskId}}" },
            },
        ],
    },
};

describe("browser plugin result binaries", () => {
    test("downloads a succeeded task through the manifest result endpoint", async () => {
        const sent: string[] = [];
        globalThis.yingceBrowserProtocol = (input: string) => {
            const call = JSON.parse(input) as BridgeCall;
            sent.push(String(call.op));
            if (call.op !== "buildResult") return JSON.stringify({ ok: false, error: `unexpected op ${String(call.op)}` });
            return JSON.stringify({ ok: true, data: { method: "GET", path: "/v1/files/task-7", headers: { "x-result": "1" }, auth: { type: "bearer" } } });
        };
        const axiosCalls = stubAxios();
        const fetchCalls = stubFetch(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));

        const result = await fetchBrowserPluginResult(config, { manifest: mediaManifest, request: { capability: "image", model: "gw-image-1" }, taskId: "task-7" });

        expect(result.status).toBe("succeeded");
        expect(result.taskId).toBe("task-7");
        expect(result.result?.images?.[0]).toMatchObject({ kind: "image", role: "output", mimeType: "image/png" });
        expect(result.result?.images?.[0]?.dataUrl).toStartWith("data:image/png;base64,");
        expect(sent).toEqual(["buildResult"]);
        expect(axiosCalls).toHaveLength(0);
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]?.url).toBe("https://gw.example.com/v1/files/task-7");
        expect(fetchCalls[0]?.init).toMatchObject({ method: "GET", credentials: "omit" });
        expect(fetchCalls[0]?.init.headers).toMatchObject({ authorization: "Bearer sk-live", "x-result": "1" });
    });

    test("projects video results into videos and keeps the declared content type", async () => {
        bridgeReplies({ buildResult: { method: "GET", path: "/v1/files/task-8", auth: { type: "bearer" } } });
        stubFetch(new Blob([new Uint8Array([9])]), 200, "video/mp4");

        const result = await fetchBrowserPluginResult(config, { manifest: mediaManifest, request: { capability: "video", model: "gw-video-1" }, taskId: "task-8" });

        expect(result.result?.videos?.[0]).toMatchObject({ kind: "video", mimeType: "video/mp4" });
        expect(result.result?.images).toBeUndefined();
    });

    test("throws the original download failure instead of returning an empty success", async () => {
        bridgeReplies({ buildResult: { method: "GET", path: "/v1/files/task-9", auth: { type: "bearer" } } });
        stubFetch(new Blob([new Uint8Array([0])]), 502, "text/plain");
        await expect(fetchBrowserPluginResult(config, { manifest: mediaManifest, request: { capability: "image" }, taskId: "task-9" })).rejects.toThrow("插件结果下载失败（HTTP 502）");
    });

    test("requires a declared result operation and an upstream task id", async () => {
        await expect(fetchBrowserPluginResult(config, { manifest, request: { capability: "image" }, taskId: "task-1" })).rejects.toThrow("没有声明结果下载操作");
        await expect(fetchBrowserPluginResult(config, { manifest: mediaManifest, request: { capability: "image" }, taskId: "" })).rejects.toThrow("缺少上游任务 ID");
    });

    test("does not download inside create, so the task id can be persisted first", async () => {
        let buildResult = 0;
        globalThis.yingceBrowserProtocol = (input: string) => {
            const call = JSON.parse(input) as BridgeCall;
            const op = String(call.op);
            if (op === "buildResult") {
                buildResult += 1;
                return JSON.stringify({ ok: false, error: "should not download during create" });
            }
            if (op === "buildCreate") return JSON.stringify({ ok: true, data: { method: "POST", path: "/v1/tasks", contentType: "application/json", body: {} } });
            if (op === "parseCreate") return JSON.stringify({ ok: true, data: { taskId: "task-1", status: "succeeded" } });
            return JSON.stringify({ ok: false, error: `unexpected op ${op}` });
        };
        stubAxios({ data: { task_id: "task-1" } });

        const result = await createBrowserPluginTask(config, mediaManifest, { capability: "image", model: "gw-image-1" });

        expect(result).toMatchObject({ status: "succeeded", taskId: "task-1" });
        expect(result.result).toBeUndefined();
        expect(buildResult).toBe(0);
    });

    test("originPath result endpoints leave the channel prefix boundary without widening the default guard", async () => {
        bridgeReplies({ buildResult: { method: "GET", path: "/api/files/task-5", originPath: true, auth: { type: "bearer" } } });
        const fetchCalls = stubFetch(new Blob([new Uint8Array([5])], { type: "image/webp" }));

        const result = await fetchBrowserPluginResult(config, { manifest: mediaManifest, request: { capability: "image" }, taskId: "task-5" });

        expect(fetchCalls[0]?.url).toBe("https://gw.example.com/api/files/task-5");
        expect(result.result?.images?.[0]?.mimeType).toBe("image/webp");
        // 默认 guard 未被放宽：非声明式插件请求仍然只能落在所选 Base 路径内。
        expect(() => channelRequest({ ...config, interfaceType: "openai-image" }, "https://gw.example.com/api/files/task-5")).toThrow("请求地址超出所选个人渠道范围");
    });
});
