import { afterEach, beforeEach, expect, test } from "bun:test";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import { browserPluginRequest, imageSizeDeclaration } from "../src/services/browser-plugin-request";

// 只验证投影：像素/比例规则全在 Go（normalizeImage）里。桥用 globalThis 假实现替换，
// 不用 mock.module —— 模块级替换在 Bun 里不会恢复，会污染同进程的其他测试文件。
type Recorded = { op: string; imageSize?: Record<string, unknown>; request: Record<string, unknown> };

const originalBridge = globalThis.yingceBrowserProtocol;
let calls: Recorded[] = [];
let normalize: (request: Record<string, unknown>) => Record<string, unknown> = (request) => request;

const capabilityConfig = {
    image: {
        parameters: [
            { name: "size", label: "尺寸", type: "string", binding: "aspectRatio", encoding: "pixels", values: ["1:1", "16:9"], default: "1:1" },
            { name: "imageResolution", label: "分辨率", type: "string", binding: "resolution", values: ["1k", "2k"], default: "1k" },
            { name: "count", label: "数量", type: "integer", values: [1, 2, 4], default: 2, min: 1, max: 4 },
        ],
        references: { promptMaxChars: 1000, maxImages: 4, maxImageBytes: 10_000_000, maskSupported: false },
        size: {
            parameter: "aspect_ratio",
            values: ["1:1", "16:9"],
            default: "1:1",
            allowCustom: false,
            presets: [
                { ratio: "1:1", tier: "1k", size: "1024x1024", width: 1024, height: 1024 },
                { ratio: "16:9", tier: "1k", size: "1536x864", width: 1536, height: 864 },
            ],
        },
        resolution: { supported: true, values: ["1k", "2k"], default: "1k" },
        quality: { supported: false, values: [], default: "auto" },
        transparentBackground: { supported: false, default: false },
        responseFormat: { supported: false },
    },
};

function imageChannel() {
    return createModelChannel({
        id: "demo-image", scope: "user", apiFormat: "openai", baseUrl: "https://plugin.invalid/v1", apiKey: "synthetic-plugin-key",
        models: ["demo-image"], interfaceType: "demo-image",
        modelCosts: [{
            model: "demo-image", capability: "image" as const, protocol: "demo-image" as const,
            billingMode: "fixed_request" as const, unitPriceMicrocredits: 0, capabilityConfig,
        }],
    });
}

function options(overrides: Record<string, unknown> = {}) {
    const channel = imageChannel();
    const config = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "demo-image"), count: "1", size: "16:9", quality: "auto" };
    return { mode: "image", prompt: "一只猫", config, metadata: {}, ...overrides } as unknown as Parameters<typeof browserPluginRequest>[0];
}

beforeEach(() => {
    calls = [];
    normalize = (request) => request;
    // 与 browser-plugin-generation 同一套做法：只替换桥的全局入口，测试后逐项还原。
    globalThis.yingceBrowserProtocol = (input) => {
        const call = JSON.parse(input) as Recorded;
        calls.push(call);
        if (call.op === "normalizeImage") return JSON.stringify({ ok: true, data: normalize(call.request) });
        return JSON.stringify({ ok: false, error: `unexpected op ${call.op}` });
    };
});

afterEach(() => {
    if (originalBridge) globalThis.yingceBrowserProtocol = originalBridge;
    else Reflect.deleteProperty(globalThis, "yingceBrowserProtocol");
});

test("图片请求把尺寸规范化交给 Go：声明只搬运数据，结果以桥返回为准", async () => {
    normalize = (request) => ({ ...request, aspectRatio: "1536x864", output: { ...(request.output as Record<string, unknown>), aspectRatio: "1536x864" } });

    const request = await browserPluginRequest(options());

    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("normalizeImage");
    expect(calls[0].imageSize).toMatchObject({
        parameter: "aspect_ratio",
        encoding: "pixels",
        usesParameters: true,
        interfaceType: "demo-image",
        values: ["1:1", "16:9"],
        presets: [
            { ratio: "1:1", tier: "1k", size: "1024x1024", width: 1024, height: 1024 },
            { ratio: "16:9", tier: "1k", size: "1536x864", width: 1536, height: 864 },
        ],
        resolution: { supported: true, values: ["1k", "2k"], default: "1k" },
    });
    // size 不进 imageParameters：出网形状由 Go 决定，避免前端再算一次像素。
    expect(calls[0].request.imageParameters).toEqual({ imageResolution: "1k", count: 1 });
    expect(calls[0].request.aspectRatio).toBe("16:9");
    expect(request.aspectRatio).toBe("1536x864");
    expect(request.output).toMatchObject({ aspectRatio: "1536x864" });
});

test("声明值与画像默认值优先于画布残留配置", async () => {
    const base = options().config as Record<string, unknown>;
    const { count: _ignored, ...rest } = base;
    const request = await browserPluginRequest(options({ config: rest }));

    // count 参数没有宿主输入时取声明默认值 2，而不是兜底的 1。
    expect(request.output).toMatchObject({ count: 2, resolution: "1k" });
    expect(request.imageCount).toBe(2);
    expect((request.extra as Record<string, unknown>).count).toBe("2");
    expect(request.aspectRatio).toBe("16:9");

    // 宿主控件仍以画布显式选择为准。
    const chosen = await browserPluginRequest(options({ config: { ...base, count: "4", imageResolution: "2k" } }));
    expect(chosen.output).toMatchObject({ count: 4, resolution: "2k" });
});

test("视频请求不进入图片规范化", async () => {
    const request = await browserPluginRequest(options({ mode: "video", metadata: { videoSeconds: 5 } }));
    expect(calls).toHaveLength(0);
    expect(request.capability).toBe("video");
});

test("画像缺失时不产生声明", () => {
    expect(imageSizeDeclaration(undefined)).toBeUndefined();
    expect(imageSizeDeclaration({ ...capabilityConfig.image, parameters: undefined } as never, "demo-image")).toMatchObject({
        usesParameters: false,
        interfaceType: "demo-image",
    });
});
