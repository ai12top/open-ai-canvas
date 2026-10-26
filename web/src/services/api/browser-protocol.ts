/**
 * 浏览器声明式插件协议桥：只负责加载 Go WASM 运行时并做 JSON 往返，
 * 不碰 HTTP、URL 拼接、凭据、持久化或轮询调度。协议语义全部来自后端
 * 同一份 Go 实现（globalThis.yingceBrowserProtocol）。
 */

export type BrowserProtocolOperation = "load" | "describe" | "buildCreate" | "buildPoll" | "buildCancel" | "buildResult" | "parseCreate" | "parsePoll";

export type BrowserPluginAuth = {
    type?: string;
    field?: string;
    secretField?: string;
    header?: string;
    prefix?: string;
    query?: string;
    username?: string;
};

/** 上游媒体引用：与 Go protocol.MediaReference 同形。 */
export type BrowserPluginReference = {
    id?: string;
    url?: string;
    dataUrl?: string;
    kind?: string;
    role?: string;
    mimeType?: string;
    name?: string;
    order?: number;
    weight?: number;
    ephemeral?: boolean;
    metadata?: Record<string, unknown>;
};

export type BrowserPluginProvider = {
    id?: string;
    label?: string;
    capabilities?: string[];
    scopes?: string[];
    baseUrl?: string;
    auth?: BrowserPluginAuth;
    /** 独立的 result 二进制端点（成功态无内联 URL 时由 main 按需下载）。 */
    result?: Record<string, unknown>;
    /** Go describe 的可选投影；仅用于兼容已持久化的句柄。 */
    operations?: Record<string, boolean>;
    [key: string]: unknown;
};

/** 原始插件 manifest JSON（catalog 的 browserManifest），不是 metadata 投影。 */
export type BrowserPluginManifest = {
    apiVersion?: string;
    id?: string;
    name?: string;
    version?: string;
    author?: string;
    runtime?: Record<string, unknown>;
    contributes?: { providers?: BrowserPluginProvider[]; [key: string]: unknown };
    [key: string]: unknown;
};

/** Go protocol.GenerationRequest 的浏览器投影。 */
export type BrowserPluginRequest = {
    capability?: "text" | "image" | "video" | "audio";
    model?: string;
    prompt?: string;
    instructions?: string;
    messages?: Array<{ role: string; content: unknown }>;
    inputs?: BrowserPluginReference[];
    images?: BrowserPluginReference[];
    videos?: BrowserPluginReference[];
    audios?: BrowserPluginReference[];
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    quality?: string;
    generateAudio?: boolean;
    watermark?: boolean;
    imageCount?: number;
    operation?: string;
    output?: Record<string, unknown>;
    providerOptions?: Record<string, Record<string, unknown>>;
    imageParameters?: Record<string, unknown>;
    extra?: Record<string, unknown>;
};

export type BrowserPluginResult = {
    status: "pending" | "processing" | "succeeded" | "failed" | "cancelled";
    taskId?: string;
    result?: {
        images?: BrowserPluginReference[];
        videos?: BrowserPluginReference[];
        audios?: BrowserPluginReference[];
        text?: string;
        reasoning?: string;
        usage?: Record<string, unknown>;
    };
    message?: string;
};

/** 持久化句柄：main 存到 record.pluginTask，续查不依赖在线 catalog。 */
export type BrowserPluginHandle = {
    manifest: BrowserPluginManifest;
    request: BrowserPluginRequest;
    taskId: string;
};

/** Go build* 返回的 protocol.RequestSpec：路径保持相对，鉴权独立。 */
export type BrowserProtocolRequestSpec = {
    method?: string;
    path?: string;
    originPath?: boolean;
    contentType?: string;
    headers?: Record<string, string>;
    query?: Record<string, string[]>;
    body?: unknown;
    files?: Array<{ name: string; filename?: string; mimeType?: string; reference: BrowserPluginReference }>;
    auth?: BrowserPluginAuth;
};

export type BrowserProtocolDescription = {
    providerId?: string;
    metadata?: Record<string, unknown>;
    operations?: { create?: boolean; poll?: boolean; cancel?: boolean; result?: boolean };
};

export type BrowserProtocolCall = {
    op: BrowserProtocolOperation;
    manifest: BrowserPluginManifest;
    providerId?: string;
    baseUrl?: string;
    request?: BrowserPluginRequest;
    model?: string;
    taskId?: string;
    metadata?: Record<string, unknown>;
    body?: unknown;
};

type BrowserProtocolReply<T> = { ok: true; data: T } | { ok: false; error?: string };

/** Go wasm_exec.js 暴露的构造器，只声明本模块用到的成员。 */
type GoRuntime = {
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
};
type GoRuntimeConstructor = new () => GoRuntime;

declare global {
    var yingceBrowserProtocol: ((input: string) => string) | undefined;
    var Go: GoRuntimeConstructor | undefined;
}

const ASSET_DIRECTORY = "browser-protocol";

let loading: Promise<void> | null = null;

export function browserProtocolAssetUrl(fileName: string): string {
    const base = import.meta.env.BASE_URL || "/";
    return `${base.endsWith("/") ? base : `${base}/`}${ASSET_DIRECTORY}/${fileName}`;
}

export function hasBrowserProtocolBridge(): boolean {
    return typeof globalThis.yingceBrowserProtocol === "function";
}

/**
 * 懒加载单例：同一 JS realm 只初始化一个 Go 实例；失败后清空状态以便重载。
 */
export async function ensureBrowserProtocolBridge(): Promise<void> {
    if (hasBrowserProtocolBridge()) return;
    loading ??= instantiateBridge().catch((error: unknown) => {
        loading = null;
        throw error;
    });
    await loading;
}

/** 清空加载状态；测试注入或运行时异常后重试时使用。 */
export function resetBrowserProtocolBridge(): void {
    loading = null;
    delete globalThis.yingceBrowserProtocol;
}

/** Go 侧错误是普通失败信封，这里统一转成 Error，保留原始阶段文案。 */
export async function callBrowserProtocol<T>(call: BrowserProtocolCall): Promise<T> {
    await ensureBrowserProtocolBridge();
    const bridge = globalThis.yingceBrowserProtocol;
    if (typeof bridge !== "function") throw new Error("浏览器协议运行时不可用");
    let raw: string;
    try {
        raw = bridge(JSON.stringify(call));
    } catch (error) {
        throw new Error(`浏览器协议执行失败：${error instanceof Error ? error.message : String(error)}`);
    }
    let reply: BrowserProtocolReply<T>;
    try {
        reply = JSON.parse(raw) as BrowserProtocolReply<T>;
    } catch {
        throw new Error("浏览器协议返回了无法解析的结果");
    }
    if (!reply || reply.ok !== true) throw new Error((reply && typeof reply.error === "string" && reply.error) || "浏览器协议执行失败");
    return reply.data;
}

async function instantiateBridge(): Promise<void> {
    await loadGoRuntime();
    const GoRuntime = globalThis.Go;
    if (!GoRuntime) throw new Error("浏览器协议运行时不可用");
    const response = await fetch(browserProtocolAssetUrl("protocol.wasm"));
    if (!response.ok) throw new Error(`浏览器协议包加载失败（HTTP ${response.status}）`);
    const bytes = await response.arrayBuffer();
    const runtime = new GoRuntime();
    const { instance } = await WebAssembly.instantiate(bytes, runtime.importObject);
    // Go 的 run 永不 resolve，不能 await，否则会挂住调用方。
    void runtime.run(instance);
    if (!hasBrowserProtocolBridge()) throw new Error("浏览器协议运行时未注册协议入口");
}

async function loadGoRuntime(): Promise<void> {
    if (globalThis.Go) return;
    if (typeof document === "undefined") throw new Error("当前环境不支持加载浏览器协议运行时");
    const src = browserProtocolAssetUrl("wasm_exec.js");
    const existing = document.querySelector<HTMLScriptElement>(`script[data-yingce-browser-protocol="1"]`);
    if (existing) {
        await waitForGoRuntime(existing);
        return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.yingceBrowserProtocol = "1";
    const loaded = new Promise<void>((resolve, reject) => {
        script.addEventListener("load", () => resolve(), { once: true });
        script.addEventListener("error", () => reject(new Error("浏览器协议运行时脚本加载失败")), { once: true });
    });
    document.head.append(script);
    try {
        await loaded;
        if (!globalThis.Go) throw new Error("浏览器协议运行时脚本未定义 Go");
    } catch (error) {
        script.remove();
        throw error;
    }
}

function waitForGoRuntime(script: HTMLScriptElement): Promise<void> {
    if (globalThis.Go) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        script.addEventListener("load", () => resolve(), { once: true });
        script.addEventListener("error", () => reject(new Error("浏览器协议运行时脚本加载失败")), { once: true });
    }).then(() => {
        if (!globalThis.Go) throw new Error("浏览器协议运行时脚本未定义 Go");
    });
}
