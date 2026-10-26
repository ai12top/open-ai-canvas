/**
 * 个人渠道内浏览器直连的声明式插件执行层：
 * manifest/describe（Go）→ 现有 createChannelTransport 发请求 → Go parseCreate/parsePoll。
 * 只使用用户选中的 Base URL 和浏览器内凭据，不经影策后端、不发 Docker 内网地址、
 * 不把密钥放进 URL；不重写 TS DSL，协议语义全部来自同一份 Go 实现。
 */
import { readFileAsDataUrl } from "@/lib/image-utils";
import { PERSONAL_OPENAI_PROTOCOLS, requirePersonalChannelUrl } from "@/lib/personal-channel";
import { buildApiUrl } from "@/stores/use-config-store";
import { createChannelTransport, type ChannelScene, type ChannelTransportConfig } from "@/services/api/channel-transport";
import { channelRequest, type ChannelRequest } from "@/services/api/custom-channel-relay";
import { fetchPluginProviderCatalog } from "@/services/api/plugin-catalog";
import {
    callBrowserProtocol,
    type BrowserPluginAuth,
    type BrowserPluginHandle,
    type BrowserPluginManifest,
    type BrowserPluginReference,
    type BrowserPluginRequest,
    type BrowserPluginResult,
    type BrowserProtocolDescription,
    type BrowserProtocolRequestSpec,
} from "@/services/api/browser-protocol";

export type { BrowserPluginAuth, BrowserPluginHandle, BrowserPluginManifest, BrowserPluginProvider, BrowserPluginReference, BrowserPluginRequest, BrowserPluginResult } from "@/services/api/browser-protocol";

export type BrowserPluginCapability = "image" | "video";

const PLUGIN_STATUSES = new Set<BrowserPluginResult["status"]>(["pending", "processing", "succeeded", "failed", "cancelled"]);

/**
 * 解析所选渠道的声明式插件：catalog 的 browserManifest 才是可执行标记，
 * 再用 Go describe 确认创建操作存在。返回原始 manifest，供持久化句柄复用。
 * 内置 OpenAI 协议名可能被同名插件占用（官方 openai-images 的 provider id 就是 openai-image），
 * 同名时以 catalog 为准；catalog 不可达或没有该插件时回退内置协议，返回 undefined。
 */
export async function resolveBrowserPlugin(config: ChannelTransportConfig, capability: BrowserPluginCapability): Promise<BrowserPluginManifest | undefined> {
    requireBrowserPluginConfig(config);
    const providerId = (config.interfaceType || "").trim();
    if (!providerId) throw new Error("请先选择浏览器可执行的声明式插件协议");
    const builtin = PERSONAL_OPENAI_PROTOCOLS.has(providerId);
    let providers: Awaited<ReturnType<typeof fetchPluginProviderCatalog>>;
    try {
        providers = await fetchPluginProviderCatalog("user.custom-channel", capability);
    } catch (error) {
        if (builtin) return undefined;
        throw error;
    }
    const selected = providers.find((item) => item.value === providerId);
    const manifest = selected?.browserManifest as BrowserPluginManifest | undefined;
    if (!manifest) {
        if (builtin) return undefined;
        throw new Error(selected?.browserUnsupportedReason || `当前渠道未提供${capability === "image" ? "图片" : "视频"}能力的声明式插件`);
    }
    const description = await callBrowserProtocol<BrowserProtocolDescription>({ op: "describe", manifest, providerId, baseUrl: pluginBaseUrl(config) });
    if (description.operations?.create !== true) throw new Error("所选插件没有声明创建操作");
    return manifest;
}

/** 创建任务：Go 组请求 → 浏览器直连 → Go 解析。异步任务的 taskId 放进结果里。 */
export async function createBrowserPluginTask(config: ChannelTransportConfig, manifest: BrowserPluginManifest, request: BrowserPluginRequest, signal?: AbortSignal): Promise<BrowserPluginResult> {
    requireBrowserPluginConfig(config);
    const providerId = browserPluginProviderId(manifest);
    const spec = await callBrowserProtocol<BrowserProtocolRequestSpec>({ op: "buildCreate", manifest, providerId, baseUrl: pluginBaseUrl(config), request });
    const body = await sendPluginRequest(config, manifest, spec, request, signal);
    const parsed = await callBrowserProtocol<BrowserPluginResult>({ op: "parseCreate", manifest, providerId, baseUrl: pluginBaseUrl(config), request, body });
    return normalizePluginResult(parsed);
}

/** 续查：只依赖持久化 manifest + 请求 + 上游 taskId，不读在线 catalog。 */
export async function pollBrowserPluginTask(config: ChannelTransportConfig, handle: BrowserPluginHandle, signal?: AbortSignal): Promise<BrowserPluginResult> {
    requireBrowserPluginConfig(config);
    const manifest = handle.manifest;
    const providerId = browserPluginProviderId(manifest);
    const request = handle.request || {};
    const taskId = String(handle.taskId || "").trim();
    if (!taskId) throw new Error("插件任务句柄缺少上游任务 ID");
    const base = { manifest, providerId, baseUrl: pluginBaseUrl(config), request, model: request.model, taskId } as const;
    const spec = await callBrowserProtocol<BrowserProtocolRequestSpec>({ op: "buildPoll", ...base });
    const body = await sendPluginRequest(config, manifest, spec, request, signal);
    const parsed = await callBrowserProtocol<BrowserPluginResult>({ op: "parsePoll", ...base, body });
    return normalizePluginResult(parsed, taskId);
}

/**
 * 结果落盘：create/poll 只回上游响应，不在拿到 taskId 前偷偷下载。成功但无内联媒体的插件
 * （如 newapi-media-task-v1）由 main 先把 handle 写进 record，再按需调用这里用 manifest 的
 * result 端点取二进制并投影成 images/videos。失败原样抛出，交给 runner 既有失败/恢复路径，
 * 绝不用空结果冒充成功。
 */
export async function fetchBrowserPluginResult(config: ChannelTransportConfig, handle: BrowserPluginHandle, signal?: AbortSignal): Promise<BrowserPluginResult> {
    requireBrowserPluginConfig(config);
    const manifest = handle?.manifest;
    if (!manifest) throw new Error("插件任务句柄缺少 manifest");
    const providerId = browserPluginProviderId(manifest);
    if (!browserPluginProviderResult(manifest, providerId)) throw new Error("所选插件没有声明结果下载操作");
    const taskId = String(handle.taskId || "").trim();
    if (!taskId) throw new Error("插件任务句柄缺少上游任务 ID");
    const request = handle.request || {};
    const spec = await callBrowserProtocol<BrowserProtocolRequestSpec>({
        op: "buildResult",
        manifest,
        providerId,
        baseUrl: pluginBaseUrl(config),
        request,
        model: request.model,
        taskId,
    });
    const blob = await sendPluginBlob(config, manifest, spec, signal);
    const video = request.capability === "video";
    const reference: BrowserPluginReference = {
        dataUrl: await readFileAsDataUrl(blob),
        kind: video ? "video" : "image",
        role: "output",
        mimeType: blob.type || spec.contentType || undefined,
        name: spec.files?.[0]?.filename,
    };
    return { status: "succeeded", taskId, result: video ? { videos: [reference] } : { images: [reference] } };
}

/**
 * 结果媒体下载：同源媒体（用户选中的 Base URL 主机）带 manifest 鉴权，第三方 CDN 与
 * data:/blob: 一律不带密钥；凭证始终 omit。
 */
export function pluginDownloadRequest(config: ChannelTransportConfig, manifest: BrowserPluginManifest, url: string): ChannelRequest {
    const target = (url || "").trim();
    if (!target) throw new Error("缺少待下载的媒体地址");
    if (config.channelScope !== "user" || !/^https?:\/\//iu.test(target)) return { url: target, headers: {}, credentials: "omit" };
    const relayConfig = { ...config, declarativePlugin: true };
    const base = new URL(pluginBaseUrl(config));
    if (new URL(target).origin !== base.origin) return { url: target, headers: {}, credentials: "omit" };
    const authHeaders = browserPluginAuthHeaders(config, browserPluginAuth(manifest));
    try {
        return channelRequest(relayConfig, target, authHeaders);
    } catch {
        // 结果媒体可能落在渠道路径之外，但同源主机仍是用户选中的渠道；只借用它的鉴权头。
        return { ...channelRequest(relayConfig, base.toString(), authHeaders), url: target };
    }
}

function requireBrowserPluginConfig(config: ChannelTransportConfig): void {
    if (config.channelScope !== "user") throw new Error("声明式插件只在个人渠道内于浏览器直连执行");
    requirePersonalChannelUrl(config.baseUrl);
}

function pluginBaseUrl(config: ChannelTransportConfig): string {
    return requirePersonalChannelUrl(config.baseUrl);
}

function browserPluginProviders(manifest: BrowserPluginManifest) {
    return manifest?.contributes?.providers || [];
}

function browserPluginProviderId(manifest: BrowserPluginManifest): string {
    const providerId = String(browserPluginProviders(manifest)[0]?.id || "").trim();
    if (!providerId) throw new Error("插件 manifest 缺少 provider ID");
    return providerId;
}

function browserPluginAuth(manifest: BrowserPluginManifest): BrowserPluginAuth | undefined {
    return browserPluginProviders(manifest).find((provider) => provider.auth)?.auth;
}

/** manifest 里声明了 result 端点才允许下载（与 Go describe 的 operations.result 同源）。 */
function browserPluginProviderResult(manifest: BrowserPluginManifest, providerId: string): boolean {
    const provider = browserPluginProviders(manifest).find((item) => item.id === providerId);
    return Boolean(provider?.result) || provider?.operations?.result === true;
}

async function sendPluginRequest(config: ChannelTransportConfig, manifest: BrowserPluginManifest, spec: BrowserProtocolRequestSpec, request: BrowserPluginRequest, signal?: AbortSignal): Promise<unknown> {
    const url = pluginRequestUrl(config, spec);
    const contentType = (spec.contentType || "").trim();
    const headers: Record<string, string> = { ...(spec.headers || {}), ...browserPluginAuthHeaders(config, spec.auth ?? browserPluginAuth(manifest)) };
    const transport = createChannelTransport(pluginTransportConfig(config, spec), pluginScene(request));
    const method = (spec.method || "POST").trim().toUpperCase();
    if (method === "GET") return transport.get<unknown>(url, { signal, headers });
    if (method !== "POST") throw new Error(`声明式插件暂不支持 ${method} 请求`);
    if (spec.files?.length || contentType.toLowerCase().startsWith("multipart/form-data")) {
        return transport.postForm<unknown>(url, await browserPluginFormData(spec, signal), { signal, headers });
    }
    if (contentType) headers["Content-Type"] = contentType;
    if (contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
        return transport.postJson<unknown>(url, new URLSearchParams(pluginFormEntries(spec.body)).toString(), { signal, headers });
    }
    return transport.postJson<unknown>(url, spec.body ?? {}, { signal, headers });
}

function pluginScene(request: BrowserPluginRequest): ChannelScene {
    return request.capability === "video" ? "video" : request.capability === "audio" ? "audio" : "image";
}

/**
 * 声明式插件请求的同源边界：originPath 允许渠道根下的任意路径（如 Base=/v1、path=/api/...），
 * 只有把 transport 的 baseUrl 收紧到所选 URL 的 origin 才能通过 channelRequest 的路径 guard；
 * 其余请求仍用用户选中的 Base URL，guard 语义不变（这里只改插件内部的局部配置）。
 */
function pluginTransportConfig(config: ChannelTransportConfig, spec: BrowserProtocolRequestSpec): ChannelTransportConfig {
    const baseUrl = pluginBaseUrl(config);
    return { ...config, declarativePlugin: true, baseUrl: spec.originPath ? new URL(baseUrl).origin : baseUrl };
}

/** 结果二进制端点：依旧经过 channelRequest（同源校验 + omit 凭证），GET 后交给调用方投影。 */
async function sendPluginBlob(config: ChannelTransportConfig, manifest: BrowserPluginManifest, spec: BrowserProtocolRequestSpec, signal?: AbortSignal): Promise<Blob> {
    const method = (spec.method || "GET").trim().toUpperCase();
    if (method !== "GET") throw new Error(`声明式插件结果端点暂不支持 ${method} 请求`);
    const headers: Record<string, string> = { ...(spec.headers || {}), ...browserPluginAuthHeaders(config, spec.auth ?? browserPluginAuth(manifest)) };
    const request = channelRequest(pluginTransportConfig(config, spec), pluginRequestUrl(config, spec), headers);
    const response = await fetch(request.url, { method, headers: request.headers, credentials: request.credentials, signal });
    if (!response.ok) throw new Error(`插件结果下载失败（HTTP ${response.status}）`);
    const declared = ((response.headers.get("content-type") || "").split(";")[0] || "").trim();
    const blob = await response.blob();
    return declared && blob.type !== declared ? new Blob([blob], { type: declared }) : blob;
}

/** 路径保持相对；originPath 表示从 Base URL 的 origin 根拼接，否则沿用现有 prefix/`/v1` 去重语义。 */
function pluginRequestUrl(config: ChannelTransportConfig, spec: BrowserProtocolRequestSpec): string {
    const path = (spec.path || "").trim();
    if (!path) throw new Error("声明式插件未提供请求路径");
    if (/^[a-z][a-z0-9+.-]*:/iu.test(path)) throw new Error("声明式插件的请求地址必须相对于所选渠道 Base URL");
    const baseUrl = pluginBaseUrl(config);
    const joined = spec.originPath ? new URL(path.startsWith("/") ? path : `/${path}`, new URL(baseUrl).origin).toString() : buildApiUrl(baseUrl, path);
    return appendPluginQuery(joined, spec.query);
}

function appendPluginQuery(url: string, query?: Record<string, string[]>): string {
    const entries = Object.entries(query || {}).flatMap(([name, values]) => (values || []).filter((value) => value !== undefined && value !== null).map((value) => [name, String(value)] as const));
    if (!entries.length) return url;
    const parsed = new URL(url);
    for (const [name, value] of entries) parsed.searchParams.append(name, value);
    return parsed.toString();
}

/**
 * manifest 鉴权投影。空类型沿用个人渠道的默认 Bearer；签名/query 鉴权不会进入浏览器
 * （catalog 与 Go bridge 已排除），其它未知类型明确拒绝而不是静默发出无鉴权请求。
 */
function browserPluginAuthHeaders(config: ChannelTransportConfig, auth?: BrowserPluginAuth): Record<string, string> {
    const apiKey = (config.apiKey || "").trim();
    const type = (auth?.type || "").trim().toLowerCase();
    const prefix = auth?.prefix ?? "";
    if (!type || type === "none") return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    if (!apiKey) throw new Error("当前插件需要 API Key，请先在渠道设置中填写");
    switch (type) {
        case "bearer":
            return { Authorization: `${prefix || "Bearer "}${apiKey}` };
        case "header":
        case "api-key":
        case "apikey":
        case "anthropic":
            return { [auth?.header || "x-api-key"]: `${prefix}${apiKey}` };
        case "google-api-key":
        case "gemini":
            return { [auth?.header || "x-goog-api-key"]: apiKey };
        case "basic":
            return { Authorization: `Basic ${btoa(`${auth?.username || ""}:${apiKey}`)}` };
        default:
            throw new Error(`声明式插件暂不支持该鉴权方式：${auth?.type}`);
    }
}

function pluginFormEntries(body: unknown): Array<[string, string]> {
    return Object.entries(asRecord(body)).flatMap(([name, value]) => (value === undefined || value === null ? [] : [[name, typeof value === "string" ? value : JSON.stringify(value)] as [string, string]]));
}

async function browserPluginFormData(spec: BrowserProtocolRequestSpec, signal?: AbortSignal): Promise<FormData> {
    const form = new FormData();
    for (const [name, value] of pluginFormEntries(spec.body)) form.append(name, value);
    for (const file of spec.files || []) {
        if (!file?.name) continue;
        const reference = file.reference || {};
        const blob = await pluginReferenceBlob(reference, signal);
        form.append(file.name, blob, file.filename || reference.name || file.name);
    }
    return form;
}

/** 素材准备由 main 负责；这里只把已声明的 dataUrl / url 读成 Blob，凭证一律 omit。 */
async function pluginReferenceBlob(reference: BrowserPluginReference, signal?: AbortSignal): Promise<Blob> {
    const source = reference.dataUrl || reference.url || "";
    if (!source) throw new Error("插件上传素材缺少可读取的媒体数据");
    const response = await fetch(source, { credentials: "omit", signal });
    if (!response.ok) throw new Error(`插件上传素材读取失败（HTTP ${response.status}）`);
    return response.blob();
}

function normalizePluginResult(parsed: BrowserPluginResult | undefined, fallbackTaskId?: string): BrowserPluginResult {
    if (!parsed || typeof parsed !== "object") throw new Error("插件协议未返回结果");
    const status = parsed.status;
    if (!PLUGIN_STATUSES.has(status)) throw new Error(`插件协议返回了未知状态：${String(status)}`);
    return { status, taskId: parsed.taskId || fallbackTaskId, result: parsed.result, message: parsed.message };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
