import { describe, expect, test } from "bun:test";

import { applicableChannelCapability, sanitizeChannelCapabilityConfig, sanitizeChannelCapabilityMeta, type ChannelCapabilityMeta } from "../src/lib/capability-catalog";
import { applyFetchedChannelModelCatalog, mergeFetchedChannelModelCosts, sanitizeChannelModelCatalogItem, type ChannelModelCatalogItem } from "../src/lib/channel-model-catalog";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { createModelChannel, type ModelChannel } from "../src/stores/use-config-store";

type ChannelCost = NonNullable<ModelChannel["modelCosts"]>[number];

const freshMeta = (overrides: Partial<ChannelCapabilityMeta> = {}): ChannelCapabilityMeta => ({
    schemaVersion: 1,
    revision: 12,
    status: "fresh",
    sourceVersion: "gateway-2026-10-27",
    refreshedAt: 1_761_600_000,
    ...overrides,
});

/** 网关一次真实返回的图片能力增量（quality 与 resolution 是两个独立维度）。 */
function imagePayload(overrides: Record<string, unknown> = {}) {
    return {
        references: { promptMaxChars: 4000, maxImages: 4, maxImageBytes: 10 * 1024 * 1024, maskSupported: true },
        size: { parameter: "aspect_ratio", values: ["1:1", "16:9", "9:16"], default: "16:9", allowCustom: false },
        resolution: { supported: true, values: ["1k", "2k"], default: "2k" },
        quality: { supported: true, values: ["low", "high"], default: "high" },
        transparentBackground: { supported: false, default: false },
        responseFormat: { supported: true, default: "b64_json" },
        outputFormat: { supported: false },
        maxOutputs: 1,
        ...overrides,
    };
}

function videoPayload(overrides: Record<string, unknown> = {}) {
    return {
        references: {
            promptMaxChars: 2000,
            minImages: 0,
            maxImages: 2,
            maxImageBytes: 8_000_000,
            maxVideos: 1,
            maxVideoBytes: 64_000_000,
            maxVideoDurationSeconds: 30,
            maxAudios: 0,
            maxAudioBytes: 0,
            maxAudioDurationSeconds: 0,
        },
        duration: { selection: "range", min: 2, max: 10, step: 1, default: 5 },
        ratios: ["16:9", "9:16"],
        defaultRatio: "16:9",
        resolutions: ["720p", "1080p"],
        defaultResolution: "1080p",
        generateAudio: { supported: true, default: false },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
        ...overrides,
    };
}

function imageConfig(overrides: Record<string, unknown> = {}) {
    return { version: 1, image: imagePayload(overrides) };
}

function videoConfig(overrides: Record<string, unknown> = {}) {
    return { version: 1, video: videoPayload(overrides) };
}

/** 走真实的目录收窄路径：网关原始 JSON → sanitizer → 渠道合并。 */
function catalogFrom(payloads: Array<Record<string, unknown>>): ChannelModelCatalogItem[] {
    return payloads.map((payload) => {
        const item = sanitizeChannelModelCatalogItem(payload);
        expect(item).not.toBeNull();
        return item as ChannelModelCatalogItem;
    });
}

function imageEntry(overrides: Record<string, unknown> = {}) {
    return {
        id: "gpt-image-1",
        displayName: "GPT Image 1",
        modelType: "image",
        protocol: "openai-image",
        capabilityMeta: freshMeta(),
        capabilityConfig: imageConfig(),
        ...overrides,
    };
}

function videoEntry(overrides: Record<string, unknown> = {}) {
    return {
        id: "seedance-1-pro",
        displayName: "Seedance 1 Pro",
        modelType: "video",
        protocol: "newapi",
        capabilityMeta: freshMeta(),
        capabilityConfig: videoConfig(),
        ...overrides,
    };
}

function channelWith(costs: ChannelCost[], models?: string[], overrides: Partial<ModelChannel> = {}): ModelChannel {
    return createModelChannel({
        id: "ch",
        name: "个人插件渠道",
        baseUrl: "https://plugin.example",
        apiKey: "test-key",
        apiFormat: "openai",
        interfaceType: "openai-image",
        models: models || costs.map((cost) => cost.model),
        modelCosts: costs,
        ...overrides,
    });
}

/** 用户此前手配的旧能力：价格、计费、可用性都必须在自动填参后原样保留。 */
function manualImageCost(overrides: Partial<ChannelCost> = {}): ChannelCost {
    return {
        model: "gpt-image-1",
        displayName: "手配图像",
        capability: "image",
        protocol: "openai-image",
        billingMode: "fixed_request",
        unitPriceMicrocredits: 120_000,
        available: false,
        capabilityConfig: {
            version: 1,
            image: {
                references: { promptMaxChars: 1000, maxImages: 9, maxImageBytes: 4_000_000, maskSupported: false },
                size: { parameter: "size", values: ["1024x1024"], default: "1024x1024", allowCustom: false },
                resolution: { supported: true, values: ["4k"], default: "4k" },
                quality: { supported: true, values: ["standard"], default: "standard" },
                transparentBackground: { supported: false, default: false },
                responseFormat: { supported: true, default: "url" },
                outputFormat: { supported: false },
                maxOutputs: 1,
            },
        },
        ...overrides,
    };
}

function readProfile(modelCosts: ChannelCost[], model: string, protocol = "openai-image") {
    return modelCapabilityConfigFor({ channels: [{ id: "ch", models: modelCosts.map((cost) => cost.model), modelCosts: modelCosts.map((cost) => ({ model: cost.model, protocol: cost.protocol || protocol, capabilityConfig: cost.capabilityConfig })) }] }, `ch::${model}`);
}

describe("personal channel capability application", () => {
    test("applies a fresh image capability and keeps the hand-configured price, billing and availability", () => {
        const channel = channelWith([manualImageCost()]);
        const applied = applyFetchedChannelModelCatalog(channel, catalogFrom([imageEntry()]), { selectedProtocol: channel.interfaceType });

        expect(applied.skipped).toEqual([]);
        expect(applied.models).toEqual(["gpt-image-1"]);
        expect(applied.modelCosts).toHaveLength(1);
        const cost = applied.modelCosts[0]!;
        expect(cost.unitPriceMicrocredits).toBe(120_000);
        expect(cost.billingMode).toBe("fixed_request");
        expect(cost.available).toBe(false);
        expect(cost.capability).toBe("image");
        expect(cost.protocol).toBe("openai-image");
        expect(cost.displayName).toBe("GPT Image 1");
        expect(cost.capabilityConfig).toEqual(imageConfig());
    });

    test("keeps image quality and resolution as independent dimensions through the real read path", () => {
        const channel = channelWith([manualImageCost()]);
        const applied = applyFetchedChannelModelCatalog(channel, catalogFrom([imageEntry()]));
        const profile = readProfile(applied.modelCosts, "gpt-image-1");

        expect(profile.image!.quality).toEqual({ supported: true, values: ["low", "high"], default: "high" });
        expect(profile.image!.resolution).toEqual({ supported: true, values: ["1k", "2k"], default: "2k" });
        expect(profile.image!.resolutionUsesQuality).not.toBe(true);
        expect(profile.image!.references.maxImages).toBe(4);
    });

    test("replaces a shrunk fresh capability instead of unioning it with the previous one", () => {
        const channel = channelWith([manualImageCost()]);
        const shrunk = imageConfig({ resolution: { supported: true, values: ["1k"], default: "1k" }, quality: { supported: false, values: [], default: "auto" } });
        const applied = applyFetchedChannelModelCatalog(channel, catalogFrom([imageEntry({ capabilityConfig: shrunk })]));
        const image = applied.modelCosts[0]!.capabilityConfig!.image!;

        expect(image.quality).toEqual({ supported: false, values: [], default: "auto" });
        expect(image.resolution).toEqual({ supported: true, values: ["1k"], default: "1k" });
        expect(image.references.maxImages).toBe(4);
        expect(JSON.stringify(image)).not.toContain("4k");
        expect(JSON.stringify(image)).not.toContain("standard");
    });

    test("applies video aspect ratios, duration, references and operations", () => {
        const cost: ChannelCost = { model: "seedance-1-pro", capability: "video", protocol: "newapi", billingMode: "per_second", unitPriceMicrocredits: 30_000 };
        const channel = channelWith([cost], undefined, { interfaceType: "newapi" });
        const applied = applyFetchedChannelModelCatalog(channel, catalogFrom([videoEntry()]), { selectedProtocol: "newapi" });

        expect(applied.skipped).toEqual([]);
        const video = applied.modelCosts[0]!.capabilityConfig!.video!;
        expect(video.ratios).toEqual(["16:9", "9:16"]);
        expect(video.defaultRatio).toBe("16:9");
        expect(video.duration).toEqual({ selection: "range", min: 2, max: 10, step: 1, default: 5 });
        expect(video.resolutions).toEqual(["720p", "1080p"]);
        expect(video.references.maxImages).toBe(2);
        expect(video.operations).toEqual(["text_to_video", "image_to_video", "reference_to_video"]);
        expect(video.defaultOperation).toBe("text_to_video");
        expect(applied.modelCosts[0]!.unitPriceMicrocredits).toBe(30_000);

        const profile = readProfile(applied.modelCosts, "seedance-1-pro", "newapi");
        expect(profile.video!.defaultResolution).toBe("1080p");
        expect(profile.video!.operations).toContain("reference_to_video");
    });

    test("keeps stale and unavailable rows untouched and reports why nothing was applied", () => {
        const stale = catalogFrom([imageEntry({ capabilityMeta: freshMeta({ status: "stale" }), capabilityConfig: undefined })]);
        const unavailable = catalogFrom([imageEntry({ capabilityMeta: freshMeta({ status: "unavailable" }), capabilityConfig: undefined })]);
        const channel = channelWith([manualImageCost()]);

        const staleResult = applyFetchedChannelModelCatalog(channel, stale);
        expect(staleResult.skipped).toEqual([{ model: "gpt-image-1", reason: "网关能力已过期（stale）" }]);
        expect(staleResult.modelCosts[0]!.capabilityConfig).toEqual(manualImageCost().capabilityConfig);
        expect(staleResult.modelCosts[0]!.unitPriceMicrocredits).toBe(120_000);

        const unavailableResult = applyFetchedChannelModelCatalog(channel, unavailable);
        expect(unavailableResult.skipped[0]!.reason).toBe("网关暂未提供该模型能力（unavailable）");
        expect(unavailableResult.modelCosts[0]!.capabilityConfig).toEqual(manualImageCost().capabilityConfig);
    });

    test("rejects an unsupported capability contract version", () => {
        const channel = channelWith([manualImageCost()]);
        const applied = applyFetchedChannelModelCatalog(channel, catalogFrom([imageEntry({ capabilityMeta: freshMeta({ schemaVersion: 2 }) })]));

        expect(applied.skipped).toEqual([{ model: "gpt-image-1", reason: "不支持的能力契约版本 v2" }]);
        expect(applied.modelCosts[0]!.capabilityConfig).toEqual(manualImageCost().capabilityConfig);
    });

    test("keeps manual models and prices when a stale catalog does not return them", () => {
        const manual: ChannelCost = { model: "manual-image", capability: "image", protocol: "openai-image", billingMode: "fixed_request", unitPriceMicrocredits: 88_000 };
        const channel = channelWith([manualImageCost(), manual], ["gpt-image-1", "manual-image"]);
        const applied = applyFetchedChannelModelCatalog(channel, catalogFrom([imageEntry({ capabilityMeta: freshMeta({ status: "stale" }), capabilityConfig: undefined })]));

        expect(applied.models).toEqual(["gpt-image-1", "manual-image"]);
        expect(applied.modelCosts.map((cost) => cost.model)).toEqual(["gpt-image-1", "manual-image"]);
        expect(applied.modelCosts[1]).toEqual(manual);
    });

    test("never drops local manual models even when the whole directory is fresh", () => {
        const manual: ChannelCost = { model: "manual-image", capability: "image", protocol: "openai-image", billingMode: "fixed_request", unitPriceMicrocredits: 88_000 };
        const channel = channelWith([manualImageCost(), manual], ["gpt-image-1", "manual-image"]);
        const applied = applyFetchedChannelModelCatalog(channel, catalogFrom([imageEntry()]));

        // fresh 只代表「同 ID 的能力可以整份替换」，无权删掉目录这轮没返回的手配行。
        expect(applied.models).toEqual(["gpt-image-1", "manual-image"]);
        expect(applied.modelCosts.map((cost) => cost.model)).toEqual(["gpt-image-1", "manual-image"]);
        expect(applied.modelCosts[1]).toEqual(manual);
    });

    test("refuses a protocol or model-type mismatch and says so", () => {
        const channel = channelWith([manualImageCost()]);
        const protocolMismatch = applyFetchedChannelModelCatalog(channel, catalogFrom([imageEntry({ protocol: "libtv-image" })]));
        expect(protocolMismatch.skipped).toEqual([{ model: "gpt-image-1", reason: "协议不匹配（目录 libtv-image ≠ 渠道 openai-image）" }]);
        expect(protocolMismatch.modelCosts[0]!.capabilityConfig).toEqual(manualImageCost().capabilityConfig);

        const kindMismatch = applyFetchedChannelModelCatalog(channel, catalogFrom([imageEntry({ modelType: "video", capabilityConfig: videoConfig() })]));
        expect(kindMismatch.skipped).toEqual([{ model: "gpt-image-1", reason: "目录声明的模型类型（video）与已配置能力（image）不一致" }]);
        expect(kindMismatch.modelCosts[0]!.capabilityConfig).toEqual(manualImageCost().capabilityConfig);
    });

    test("never guesses a protocol for an unconfigured row", () => {
        const empty = channelWith([], []);
        const catalog = catalogFrom([imageEntry()]);

        const guess = applyFetchedChannelModelCatalog(empty, catalog);
        expect(guess.modelCosts).toEqual([]);
        expect(guess.models).toEqual([]);
        expect(guess.skipped).toEqual([{ model: "gpt-image-1", reason: "渠道未选定已安装插件，无法应用 openai-image 的能力" }]);

        const selected = applyFetchedChannelModelCatalog(empty, catalog, { selectedProtocol: "openai-image" });
        expect(selected.skipped).toEqual([]);
        expect(selected.modelCosts).toEqual([
            {
                model: "gpt-image-1",
                displayName: "GPT Image 1",
                capability: "image",
                protocol: "openai-image",
                billingMode: "fixed_request",
                unitPriceMicrocredits: 0,
                capabilityConfig: imageConfig(),
            },
        ]);
    });

    test("applies each configured row against its own protocol inside one channel", () => {
        const imageCost = manualImageCost();
        const videoCost: ChannelCost = { model: "seedance-1-pro", capability: "video", protocol: "newapi", billingMode: "per_second", unitPriceMicrocredits: 30_000 };
        const foreignCost: ChannelCost = { model: "gpt-image-1-b", capability: "image", protocol: "openai-image", billingMode: "fixed_request", unitPriceMicrocredits: 1 };
        const channel = channelWith([imageCost, videoCost, foreignCost]);
        const applied = applyFetchedChannelModelCatalog(channel, catalogFrom([imageEntry(), videoEntry(), imageEntry({ id: "gpt-image-1-b", protocol: "libtv-image" })]), { selectedProtocol: "newapi" });

        expect(applied.modelCosts[0]!.capabilityConfig).toEqual(imageConfig());
        expect(applied.modelCosts[1]!.capabilityConfig).toEqual(videoConfig());
        expect(applied.modelCosts[2]!.capabilityConfig).toBeUndefined();
        expect(applied.skipped).toEqual([{ model: "gpt-image-1-b", reason: "协议不匹配（目录 libtv-image ≠ 渠道 openai-image）" }]);
    });

    test("shares one merge result between the single and batch refresh paths", () => {
        const channel = channelWith([manualImageCost(), { model: "manual-video", capability: "video", protocol: "newapi", billingMode: "fixed_request", unitPriceMicrocredits: 7 }]);
        const catalog = catalogFrom([imageEntry()]);

        const applied = applyFetchedChannelModelCatalog(channel, catalog);
        expect(mergeFetchedChannelModelCosts(channel, catalog)).toEqual(applied.modelCosts);
        // models 与 modelCosts 来自同一份过滤后的候选：被跳过的富条目不会只出现在其中一侧。
        expect(applied.models).toContain("gpt-image-1");
        expect(applied.modelCosts.every((cost) => applied.models.includes(cost.model))).toBe(true);
    });

    test("keeps the legacy catalog behaviour when the directory declares no capability", () => {
        const channel = channelWith([], [], { interfaceType: undefined });
        const applied = applyFetchedChannelModelCatalog(channel, [
            { id: "legacy-video", modelType: "video", options: { aspectRatio: [{ value: "16:9" }] } },
        ]);

        expect(applied.skipped).toEqual([]);
        expect(applied.modelCosts[0]!.protocol).toBe("newapi");
        expect(applied.modelCosts[0]!.capability).toBe("video");
        expect(applied.modelCosts[0]!.capabilityConfig!.video!.ratios).toEqual(["16:9"]);
    });
});

describe("external capability validation", () => {
    test("rejects out-of-range, non-finite, unknown-enum and empty-enum capabilities", () => {
        expect(sanitizeChannelCapabilityConfig("image", imageConfig({ references: { promptMaxChars: 4000, maxImages: -1, maxImageBytes: 10, maskSupported: true } }))).toBeNull();
        expect(sanitizeChannelCapabilityConfig("image", imageConfig({ maxOutputs: Number.POSITIVE_INFINITY }))).toBeNull();
        expect(sanitizeChannelCapabilityConfig("image", imageConfig({ quality: { supported: true, values: [], default: "high" } }))).toBeNull();
        expect(sanitizeChannelCapabilityConfig("video", videoConfig({ duration: { selection: "range", min: 5, max: 2, default: 5 } }))).toBeNull();
        expect(sanitizeChannelCapabilityConfig("video", videoConfig({ operations: ["hack_everything"], defaultOperation: "hack_everything" }))).toBeNull();
        expect(sanitizeChannelCapabilityConfig("video", videoConfig({ defaultResolution: "4k" }))).toBeNull();
        expect(sanitizeChannelCapabilityConfig("image", { version: 1, image: "not-an-object" })).toBeNull();
        expect(sanitizeChannelCapabilityConfig("audio", imageConfig())).toBeNull();
    });

    test("rejects an oversized capability payload before normalizing anything", () => {
        const oversizedValues = Array.from({ length: 200 }, (_, index) => `${"x".repeat(1900)}-${index}`);
        expect(sanitizeChannelCapabilityConfig("image", imageConfig({ size: { parameter: "size", values: oversizedValues, default: "", allowCustom: true } }))).toBeNull();
    });

    test("drops only the unusable rich fields and reports the reason upstream", () => {
        const item = sanitizeChannelModelCatalogItem({ id: "broken-image", modelType: "image", protocol: "openai-image", capabilityMeta: freshMeta(), capabilityConfig: { image: { references: "nope" } } });
        // capabilityDeclared 记下「这条声明过能力」：损坏的能力不能借机滑回旧目录推断。
        expect(item).toEqual({ id: "broken-image", modelType: "image", protocol: "openai-image", capabilityMeta: freshMeta(), capabilityDeclared: true });
        expect(applicableChannelCapability(item!, "openai-image")).toEqual({ applied: false, reason: "目录未返回可用的能力配置（capabilityConfig）" });

        const badMeta = sanitizeChannelModelCatalogItem({ id: "bad-meta", modelType: "image", protocol: "openai-image", capabilityMeta: { schemaVersion: "1", status: "fresh" }, capabilityConfig: imageConfig() });
        // meta 损坏但 config 仍在：config 保留（供后续如实报错），并记下声明过能力。
        expect(badMeta).toEqual({ id: "bad-meta", modelType: "image", protocol: "openai-image", capabilityConfig: imageConfig(), capabilityDeclared: true });
        expect(sanitizeChannelCapabilityMeta({ status: "fresh" })).toBeNull();
        expect(sanitizeChannelCapabilityMeta({ schemaVersion: 1, status: "eventual" })).toBeNull();
    });

    test("round-trips a real capability config without changing what the read path sees", () => {
        for (const [protocol, model, kind] of [
            ["openai-image", "gpt-image-1", "image"],
            ["newapi", "seedance-1-pro", "video"],
        ] as const) {
            const original = defaultModelCapabilityConfig(protocol, model);
            const sanitized = sanitizeChannelCapabilityConfig(kind, JSON.parse(JSON.stringify(original)));
            expect(sanitized).not.toBeNull();

            const before = readProfile([{ model, capability: kind, protocol, billingMode: "fixed_request", unitPriceMicrocredits: 0, capabilityConfig: original }], model, protocol);
            const after = readProfile([{ model, capability: kind, protocol, billingMode: "fixed_request", unitPriceMicrocredits: 0, capabilityConfig: sanitized! }], model, protocol);
            expect(after).toEqual(before);
        }
    });
});
