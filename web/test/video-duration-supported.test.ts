import { describe, expect, test } from "bun:test";
import { defaultModelCapabilityConfig, normalizeVideoValue, videoDurationAllowed, videoDurationOptions, videoDurationSupported, type VideoCapabilityConfig } from "../src/lib/model-capabilities";
import { applicableChannelCapability, sanitizeChannelCapabilityConfig } from "../src/lib/capability-catalog";
import { modelCompatibilityError, modelRequestOptions, resolveModelGenerationDefaults } from "../src/lib/model-selection";
import { browserPluginRequest } from "../src/services/browser-plugin-request";
import { backendProviderConfig, logicalCapabilityOptions } from "../src/services/api/generation-task";
import { assertVideoCapability } from "../src/services/api/video-validation";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import { capabilitySpecFromChannelModel } from "../src/pages/admin/logical-models/model-routing-capabilities";
import { projectLogicalCapability } from "../src/lib/user-session";

function motionControlVideoPayload(overrides: Record<string, unknown> = {}) {
    return {
        references: {
            promptMaxChars: 2000,
            minImages: 0,
            maxImages: 1,
            maxImageBytes: 10_000_000,
            maxVideos: 1,
            maxVideoBytes: 50_000_000,
            maxVideoDurationSeconds: 30,
            maxAudios: 0,
            maxAudioBytes: 0,
            maxAudioDurationSeconds: 0,
        },
        durationSupported: false,
        duration: { selection: "range", min: 1, max: 1, step: 1, default: 1 },
        ratios: ["16:9", "9:16", "1:1"],
        defaultRatio: "16:9",
        resolutions: ["720p", "1080p"],
        defaultResolution: "720p",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["image_to_video", "reference_to_video"],
        defaultOperation: "image_to_video",
        ...overrides,
    };
}

describe("video durationSupported=false capability catalog parsing", () => {
    test("catalog correctly parses durationSupported: false with inert placeholder duration", () => {
        const raw = motionControlVideoPayload();
        const sanitized = sanitizeChannelCapabilityConfig("video", { version: 1, video: raw });
        expect(sanitized).not.toBeNull();
        expect(sanitized?.video?.durationSupported).toBe(false);
        expect(sanitized?.video?.duration).toEqual({ selection: "range", min: 1, max: 1, step: 1, default: 1 });
    });

    test("applicableChannelCapability preserves durationSupported: false", () => {
        const item = {
            id: "kling-v3-motion-control",
            modelType: "video",
            protocol: "libtv-video",
            capabilityMeta: { schemaVersion: 1, revision: 1, status: "fresh" as const },
            capabilityConfig: { version: 1, video: motionControlVideoPayload() as unknown as VideoCapabilityConfig },
        };
        const gate = applicableChannelCapability(item, "libtv-video");
        expect(gate.applied).toBe(true);
        if (gate.applied) {
            expect(gate.config.video?.durationSupported).toBe(false);
        }
    });
});

describe("model capabilities helper functions under durationSupported=false", () => {
    const motionProfile = motionControlVideoPayload() as unknown as VideoCapabilityConfig;
    const normalProfile = defaultModelCapabilityConfig("volcengine-ark-video", "seedance-2-0").video!;

    test("videoDurationSupported helper distinguishes supported from unsupported profiles", () => {
        expect(videoDurationSupported(motionProfile)).toBe(false);
        expect(videoDurationSupported(normalProfile)).toBe(true);
        expect(videoDurationSupported(undefined)).toBe(true);
        expect(videoDurationSupported(null)).toBe(true);
    });

    test("videoDurationOptions returns empty list when durationSupported=false", () => {
        expect(videoDurationOptions(motionProfile)).toEqual([]);
        expect(videoDurationOptions(normalProfile).length).toBeGreaterThan(0);
    });

    test("videoDurationAllowed does not restrict duration when durationSupported=false", () => {
        expect(videoDurationAllowed(motionProfile, 5)).toBe(true);
        expect(videoDurationAllowed(motionProfile, 99)).toBe(true);
        expect(videoDurationAllowed(motionProfile, 1)).toBe(true);
    });

    test("normalizeVideoValue omits seconds when durationSupported=false", () => {
        const normalized = normalizeVideoValue(motionProfile, { seconds: "5", ratio: "16:9", resolution: "720p" });
        expect(normalized.seconds).toBeUndefined();
        expect(normalized.ratio).toBe("16:9");
        expect(normalized.resolution).toBe("720p");

        const normalNormalized = normalizeVideoValue(normalProfile, { seconds: "5", ratio: "16:9", resolution: "720p" });
        expect(normalNormalized.seconds).toBe("5");
    });
});

describe("model selection and defaults under durationSupported=false", () => {
    const channel = createModelChannel({
        id: "libtv-chan",
        scope: "user",
        apiFormat: "openai",
        baseUrl: "https://libtv.example/v1",
        apiKey: "test-key",
        models: ["kling-v3-motion-control", "kling-normal"],
        interfaceType: "libtv-video",
        modelCosts: [
            {
                model: "kling-v3-motion-control",
                capability: "video",
                protocol: "libtv-video",
                billingMode: "fixed_request",
                unitPriceMicrocredits: 100,
                capabilityConfig: { version: 1, video: motionControlVideoPayload() },
            },
            {
                model: "kling-normal",
                capability: "video",
                protocol: "libtv-video",
                billingMode: "fixed_request",
                unitPriceMicrocredits: 100,
                capabilityConfig: {
                    version: 1,
                    video: {
                        ...motionControlVideoPayload(),
                        durationSupported: true,
                        duration: { selection: "range", min: 3, max: 10, step: 1, default: 5 },
                    },
                },
            },
        ],
    });

    const baseConfig = {
        ...defaultConfig,
        channels: [channel],
        videoSeconds: "5",
    };

    test("resolveModelGenerationDefaults does not apply placeholder or global videoSeconds for unsupported model", () => {
        const encodedMotion = encodeChannelModel(channel.id, "kling-v3-motion-control");
        const defaultsMotion = resolveModelGenerationDefaults(baseConfig, encodedMotion, "video");
        expect(defaultsMotion.videoSeconds).toBeUndefined();

        const encodedNormal = encodeChannelModel(channel.id, "kling-normal");
        const defaultsNormal = resolveModelGenerationDefaults(baseConfig, encodedNormal, "video");
        expect(defaultsNormal.videoSeconds).toBe("5");
    });

    test("modelCompatibilityError skips duration validation when durationSupported=false", () => {
        const encodedMotion = encodeChannelModel(channel.id, "kling-v3-motion-control");
        const encodedNormal = encodeChannelModel(channel.id, "kling-normal");

        // 100 seconds is out of range for normal model
        expect(modelCompatibilityError(baseConfig, encodedNormal, { capability: "video", videoSeconds: "100" })).toBe("不支持当前视频时长");
        // For motion model with durationSupported=false, compatibility error is skipped
        expect(modelCompatibilityError(baseConfig, encodedMotion, { capability: "video", videoSeconds: "100" })).toBe("");
    });

    test("modelRequestOptions omits videoSeconds when durationSupported=false", () => {
        const encodedMotion = encodeChannelModel(channel.id, "kling-v3-motion-control");
        const motionConfig = { ...baseConfig, model: encodedMotion, videoModel: encodedMotion };
        const optionsMotion = modelRequestOptions(motionConfig, "video");
        expect(optionsMotion.videoSeconds).toBeUndefined();

        const encodedNormal = encodeChannelModel(channel.id, "kling-normal");
        const normalConfig = { ...baseConfig, model: encodedNormal, videoModel: encodedNormal };
        const optionsNormal = modelRequestOptions(normalConfig, "video");
        expect(optionsNormal.videoSeconds).toBe(5);
    });

    test("logical-model spec routing does not expose videoSeconds when durationSupported=false", () => {
        const motionCost = channel.modelCosts![0];
        const normalCost = channel.modelCosts![1];

        const motionSpec = capabilitySpecFromChannelModel(motionCost);
        expect(motionSpec?.options?.videoSeconds).toBeUndefined();

        const normalSpec = capabilitySpecFromChannelModel(normalCost);
        expect(normalSpec?.options?.videoSeconds).toBeDefined();
    });
});

describe("request construction under durationSupported=false", () => {
    const channel = createModelChannel({
        id: "libtv-chan",
        scope: "user",
        apiFormat: "openai",
        baseUrl: "https://libtv.example/v1",
        apiKey: "synthetic-plugin-key",
        models: ["kling-v3-motion-control", "kling-normal"],
        interfaceType: "libtv-video",
        modelCosts: [
            {
                model: "kling-v3-motion-control",
                capability: "video",
                protocol: "libtv-video",
                billingMode: "fixed_request",
                unitPriceMicrocredits: 100,
                logicalCapabilitySpec: {
                    version: 1,
                    capability: "video",
                    options: { size: { values: ["16:9"] } },
                },
                capabilityConfig: { version: 1, video: motionControlVideoPayload() },
            },
            {
                model: "kling-normal",
                capability: "video",
                protocol: "libtv-video",
                billingMode: "fixed_request",
                unitPriceMicrocredits: 100,
                logicalCapabilitySpec: {
                    version: 1,
                    capability: "video",
                    options: { videoSeconds: { min: 3, max: 10, step: 1 } },
                },
                capabilityConfig: {
                    version: 1,
                    video: {
                        ...motionControlVideoPayload(),
                        durationSupported: true,
                        duration: { selection: "range", min: 3, max: 10, step: 1, default: 5 },
                    },
                },
            },
        ],
    });

    test("browserPluginRequest does not send duration or extra.videoSeconds when durationSupported=false", async () => {
        const encodedMotion = encodeChannelModel(channel.id, "kling-v3-motion-control");
        const motionConfig = { ...defaultConfig, channels: [channel], model: encodedMotion, videoSeconds: "8" };

        const motionReq = await browserPluginRequest({
            mode: "video",
            prompt: "motion test",
            config: motionConfig,
            metadata: {},
        });

        expect("durationSupported" in motionReq).toBe(false);
        expect(motionReq.output?.duration).toBeUndefined();
        expect(motionReq.extra?.videoSeconds).toBeUndefined();

        // When switching back to normal model:
        const encodedNormal = encodeChannelModel(channel.id, "kling-normal");
        const normalConfig = { ...defaultConfig, channels: [channel], model: encodedNormal, videoSeconds: "8" };

        const normalReq = await browserPluginRequest({
            mode: "video",
            prompt: "normal test",
            config: normalConfig,
            metadata: {},
        });

        expect("durationSupported" in normalReq).toBe(false);
        expect(normalReq.output?.duration).toBe(8);
        expect(normalReq.extra?.videoSeconds).toBe("8");
    });

    test("backendProviderConfig and logicalCapabilityOptions omit videoSeconds when durationSupported=false", () => {
        const encodedMotion = encodeChannelModel(channel.id, "kling-v3-motion-control");
        const motionConfig = { ...defaultConfig, channels: [channel], model: encodedMotion, videoSeconds: "8" };

        const logicalOpts = logicalCapabilityOptions(motionConfig, "video");
        expect(logicalOpts.videoSeconds).toBeUndefined();

        // normal model maintains videoSeconds
        const encodedNormal = encodeChannelModel(channel.id, "kling-normal");
        const normalConfig = { ...defaultConfig, channels: [channel], model: encodedNormal, videoSeconds: "8" };

        const normalLogicalOpts = logicalCapabilityOptions(normalConfig, "video");
        expect(normalLogicalOpts.videoSeconds).toBe(8);
    });

    test("assertVideoCapability does not fail on arbitrary duration when durationSupported=false", () => {
        const motionProfile = motionControlVideoPayload() as unknown as VideoCapabilityConfig;
        const normalProfile = {
            ...motionControlVideoPayload(),
            durationSupported: true,
            duration: { selection: "range", min: 3, max: 10, step: 1, default: 5 },
        } as unknown as VideoCapabilityConfig;

        // motion profile with durationSupported=false passes assertion
        expect(() => {
            assertVideoCapability(motionProfile, [], [{ id: "v1", name: "v.mp4", type: "video/mp4", url: "https://example.com/v.mp4" }], [], "99");
        }).not.toThrow();

        // normal profile throws for unsupported duration
        expect(() => {
            assertVideoCapability(normalProfile, [], [{ id: "v1", name: "v.mp4", type: "video/mp4", url: "https://example.com/v.mp4" }], [], "99");
        }).toThrow("视频时长不在当前模型支持范围内");
    });
});

describe("渠道默认参数与逻辑模型投影不能把时长加回来", () => {
    const channel = createModelChannel({
        id: "libtv-defaults",
        scope: "user",
        apiFormat: "openai",
        baseUrl: "https://libtv.example/v1",
        apiKey: "synthetic-plugin-key",
        models: ["kling-v3-motion-control", "kling-normal"],
        interfaceType: "libtv-video",
        modelCosts: [
            {
                model: "kling-v3-motion-control",
                capability: "video",
                protocol: "libtv-video",
                billingMode: "fixed_request",
                unitPriceMicrocredits: 100,
                defaultOptions: { videoSeconds: 8, duration: 8, seconds: 8, resolution: "1080p", style: "anime" },
                capabilityConfig: { version: 1, video: motionControlVideoPayload() },
            },
            {
                model: "kling-normal",
                capability: "video",
                protocol: "libtv-video",
                billingMode: "fixed_request",
                unitPriceMicrocredits: 100,
                defaultOptions: { videoSeconds: 8, duration: 8, seconds: 8, resolution: "1080p", style: "anime" },
                capabilityConfig: {
                    version: 1,
                    video: {
                        ...motionControlVideoPayload(),
                        durationSupported: true,
                        duration: { selection: "range", min: 3, max: 10, step: 1, default: 5 },
                    },
                },
            },
        ],
    });

    test("providerOptions 合并渠道默认参数时只剥离时长键，其余参数保留", async () => {
        const motionConfig = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "kling-v3-motion-control"), videoSeconds: "8" };
        const motionReq = await browserPluginRequest({
            mode: "video",
            prompt: "merge test",
            config: motionConfig,
            metadata: { providerOptions: { "libtv-video": { seed: 7 } } },
        });
        const motionOptions = motionReq.providerOptions?.["libtv-video"] || {};
        expect(motionOptions.videoSeconds).toBeUndefined();
        expect(motionOptions.duration).toBeUndefined();
        expect(motionOptions.seconds).toBeUndefined();
        expect(motionOptions.resolution).toBe("1080p");
        expect(motionOptions.style).toBe("anime");
        expect(motionOptions.seed).toBe(7);
        expect(motionReq.duration).toBeUndefined();

        const normalConfig = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "kling-normal"), videoSeconds: "8" };
        const normalReq = await browserPluginRequest({
            mode: "video",
            prompt: "merge test",
            config: normalConfig,
            metadata: { providerOptions: { "libtv-video": { seed: 7 } } },
        });
        const normalOptions = normalReq.providerOptions?.["libtv-video"] || {};
        expect(normalOptions.videoSeconds).toBe(8);
        expect(normalOptions.duration).toBe(8);
        expect(normalOptions.seed).toBe(7);
        expect(normalReq.duration).toBe(8);
    });

    test("逻辑模型 spec 缺少时长选项时不再推断成不支持时长", () => {
        const legacy = projectLogicalCapability({ version: 1, capability: "video", options: { size: { values: ["16:9"] } } }, {});
        expect(legacy.video?.durationSupported).toBeUndefined();
        expect(videoDurationSupported(legacy.video)).toBe(true);

        const explicit = projectLogicalCapability({ version: 1, capability: "video", options: { videoSeconds: { min: 3, max: 10, step: 1 } } }, {});
        expect(explicit.video?.durationSupported).toBeUndefined();
        expect(explicit.video?.duration).toEqual({ selection: "range", min: 3, max: 10, step: 1, default: 3 });
    });
});
