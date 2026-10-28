import { afterEach, describe, expect, test } from "bun:test";
import axios from "axios";
import directory from "./fixtures/capability-directory.generated.json";
import { createModelChannel, type ModelChannel, type ModelChannelCost } from "../src/stores/use-config-store";
import {
    applyFetchedChannelModelCatalog,
    sanitizeChannelModelCatalogItem,
    type ChannelModelCatalogItem,
} from "../src/lib/channel-model-catalog";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { imageQualityForSelection, imageResolutionTiers, imageResolutionUsesQuality, imageSizePresets, imageTierAvailable } from "../src/lib/image-size-presets";
import { fetchChannelModels } from "../src/services/api/image-models";
import type { ModelCapabilityConfig } from "../src/lib/model-capabilities";

/**
 * 这些用例不手写"理想形状"的能力 JSON：``capability-directory.generated.json`` 是
 * ``web/test/fixtures/generate-capability-directory.py`` 走宿主真实链路
 * （ModelInfo + spec -> capability_config() -> model_directory -> model_api.build_models）
 * 离线生成的产物，qcreate 分支还直接复用主仓库已提交的真实目录快照。所以这里验证的是
 * 「WebUI 解析器吃得下宿主真正会发出来的东西」，而不是「解析器吃得下我编的东西」。
 */

const records = (JSON.parse(JSON.stringify(directory)) as { data: Array<Record<string, unknown>> }).data;
const recordById = new Map(records.map((record) => [record.id as string, record]));

const RICH_IDS = [
    "dreamina/5.0",
    "dreamina/3.0-pro",
    "libtv/seedream-4",
    "libtv/kling-2.1",
    "qcreate/qwen3",
    "qcreate/wan30_prime",
];

/** 把 fixture 里的 /v1/models 记录过一遍真实的 sanitizer。 */
function catalogFromFixture(transform?: (record: Record<string, unknown>) => Record<string, unknown>) {
    const items: ChannelModelCatalogItem[] = [];
    for (const record of records) {
        const sanitized = sanitizeChannelModelCatalogItem(transform ? transform(record) : record);
        if (sanitized) items.push(sanitized);
    }
    return items;
}

/** 只取被测条目：真实目录会一次带回三家模型，未选协议的富条目本来就会进 skipped。 */
function catalogFor(...ids: string[]) {
    return catalogFromFixture().filter((item) => ids.includes(item.id));
}

function channelWith(costs: ModelChannelCost[], overrides: Partial<ModelChannel> = {}) {
    return createModelChannel({
        name: "即梦个人插件",
        baseUrl: "https://gateway.example",
        apiKey: "synthetic-key",
        apiFormat: "openai",
        interfaceType: "dreamina-cli-image",
        scope: "user",
        models: costs.map((cost) => cost.model),
        modelCosts: costs,
        ...overrides,
    });
}

function configuredCost(model: string, capability: "image" | "video", protocol: string, extra: Partial<ModelChannelCost> = {}): ModelChannelCost {
    return {
        model,
        capability,
        protocol,
        billingMode: "fixed_request",
        unitPriceMicrocredits: 250_000,
        available: false,
        ...extra,
    };
}

function readProfile(cost: ModelChannelCost) {
    return modelCapabilityConfigFor({ channels: [channelWith([cost])] }, cost.model);
}

/** 只抹掉「读路径不看」的差异：键序 + 图片 references.minImages（TS 类型里没有该字段）。 */
function canonicalConfig(config: unknown) {
    const cloned = JSON.parse(JSON.stringify(config)) as { image?: { references?: Record<string, unknown>; size?: { presets?: unknown[] } } };
    if (cloned.image?.references) delete cloned.image.references.minImages;
    // 宿主 ImageSizeConfig.presets 缺省就是 []，空数组等于「没有管理员预设」；sanitize 把它省略，
    // 读路径再按比例/质量默认生成，语义一致（已有专门用例断言选择器仍有可选项）。
    if (Array.isArray(cloned.image?.size?.presets) && !cloned.image?.size?.presets?.length) delete cloned.image?.size?.presets;
    const sortKeys = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(sortKeys);
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortKeys(item)]));
        }
        return value;
    };
    return sortKeys(cloned);
}

describe("host-generated capability directory", () => {
    const store = { models: [] as string[] };
    afterEach(() => {
        axios.request = store.original as typeof axios.request;
    });
    store.original = axios.request;

    test("the committed fixture carries the three providers with their installed plugin protocols", () => {
        expect(RICH_IDS.map((id) => [id, recordById.get(id)?.protocol, recordById.get(id)?.capabilityMeta])).toEqual([
            ["dreamina/5.0", "dreamina-cli-image", { schemaVersion: 1, revision: 12, status: "fresh", sourceVersion: "fixture-source:fixture", refreshedAt: 1761600000 }],
            ["dreamina/3.0-pro", "dreamina-cli-video", { schemaVersion: 1, revision: 12, status: "fresh", sourceVersion: "fixture-source:fixture", refreshedAt: 1761600000 }],
            ["libtv/seedream-4", "libtv-image", { schemaVersion: 1, revision: 12, status: "fresh", sourceVersion: "fixture-source:fixture", refreshedAt: 1761600000 }],
            ["libtv/kling-2.1", "libtv-video", { schemaVersion: 1, revision: 12, status: "fresh", sourceVersion: "fixture-source:fixture", refreshedAt: 1761600000 }],
            ["qcreate/qwen3", "qcreate-cli-image", { schemaVersion: 1, revision: 12, status: "fresh", sourceVersion: "fixture-source:fixture", refreshedAt: 1761600000 }],
            ["qcreate/wan30_prime", "qcreate-cli-video", { schemaVersion: 1, revision: 12, status: "fresh", sourceVersion: "fixture-source:fixture", refreshedAt: 1761600000 }],
        ]);
        expect(recordById.get("dreamina/4.0")?.capabilityMeta).toMatchObject({ status: "stale" });
        expect(recordById.get("libtv/wan-2.2")?.capabilityMeta).toMatchObject({ status: "unavailable" });
        expect(recordById.get("dreamina-image-3.0")?.capabilityConfig).toBeUndefined();
        expect(recordById.get("dreamina-video-3.0")?.capabilityConfig).toBeUndefined();
    });

    test("sanitizes every production record without changing what the read path sees", () => {
        for (const id of RICH_IDS) {
            const raw = recordById.get(id) as { capabilityConfig: ModelCapabilityConfig };
            const item = sanitizeChannelModelCatalogItem(raw);
            expect(item, id).not.toBeNull();
            // 宿主真实 JSON 里的 optional 字段不能被补默认值冒充，也不能被改写成别的能力。
            expect(canonicalConfig(item?.capabilityConfig), id).toEqual(canonicalConfig(raw.capabilityConfig));
            expect(item?.protocol).toBe(raw.capabilityMeta ? recordById.get(id)?.protocol : undefined);
        }
        // 图片能力里宿主没有 resolution / 目录没给的字段保持缺失（读路径再按 legacy 语义投影）。
        const dreaminaImage = sanitizeChannelModelCatalogItem(recordById.get("dreamina/5.0"));
        expect(Object.keys(dreaminaImage?.capabilityConfig?.image || {}).sort()).toEqual(["maxOutputs", "quality", "references", "size"]);
    });

    test("applies a real dreamina image capability and keeps price, billing and availability", () => {
        const existing = configuredCost("dreamina/5.0", "image", "dreamina-cli-image");
        const result = applyFetchedChannelModelCatalog(channelWith([existing]), catalogFor("dreamina/5.0"));
        const applied = result.modelCosts.find((cost) => cost.model === "dreamina/5.0");
        expect(applied).toMatchObject({
            capability: "image",
            protocol: "dreamina-cli-image",
            unitPriceMicrocredits: 250_000,
            billingMode: "fixed_request",
            available: false,
        });
        const profile = readProfile(applied as ModelChannelCost).image;
        expect(profile?.quality).toEqual({ supported: true, values: ["2k", "4k"], default: "2k" });
        expect(profile?.size).toEqual({ parameter: "aspect_ratio", values: ["16:9", "1:1", "9:16"], default: "1:1", allowCustom: false });
        // 宿主没声明「清晰度档位」，读路径就报不支持，而不是被补成默认档位。
        expect(profile?.resolution.supported).toBe(false);
        expect(profile?.maxOutputs).toBe(1);
        expect(result.skipped).toEqual([]);
    });

    test("applies a real qcreate image capability including transparency and formats", () => {
        const existing = configuredCost("qcreate/qwen3", "image", "qcreate-cli-image");
        const result = applyFetchedChannelModelCatalog(channelWith([existing]), catalogFor("qcreate/qwen3"));
        const applied = result.modelCosts.find((cost) => cost.model === "qcreate/qwen3") as ModelChannelCost;
        const profile = readProfile(applied).image;
        expect(profile?.quality).toEqual({ supported: true, values: ["1K", "1.5K", "2K"], default: "1K" });
        expect(profile?.references).toMatchObject({ promptMaxChars: 32000, maxImages: 2, maxImageBytes: 0, maskSupported: false });
        expect(profile?.transparentBackground).toEqual({ supported: false, default: false });
        // 读路径给 responseFormat 补的是它自己的 legacy 默认（"auto"），目录没声明就仍是「不支持」。
        expect(profile?.responseFormat).toEqual({ supported: false, default: "auto" });
        expect(profile?.outputFormat).toEqual({ supported: false });
        expect(profile?.maxOutputs).toBe(4);
    });

    test("applies a real video capability with ratios, duration, references and operations", () => {
        const existing = configuredCost("qcreate/wan30_prime", "video", "qcreate-cli-video");
        const result = applyFetchedChannelModelCatalog(channelWith([existing]), catalogFor("qcreate/wan30_prime"));
        const applied = result.modelCosts.find((cost) => cost.model === "qcreate/wan30_prime") as ModelChannelCost;
        const profile = readProfile(applied).video;
        expect(profile?.ratios).toEqual(["9:16", "4:3", "1:1", "3:4", "16:9"]);
        expect(profile?.defaultRatio).toBe("16:9");
        expect(profile?.resolutions).toEqual(["480P", "720P", "1080P"]);
        expect(profile?.defaultResolution).toBe("720P");
        expect(profile?.duration).toEqual({ selection: "range", min: 2, max: 30, step: 1, default: 15 });
        expect(profile?.operations).toEqual(["text_to_video", "image_to_video", "reference_to_video", "audio_to_video"]);
        expect(profile?.defaultOperation).toBe("text_to_video");
        expect(profile?.references).toMatchObject({ maxImages: 10, maxVideos: 5, maxVideoDurationSeconds: 30, maxAudios: 5 });
        // 宿主 qcreate 视频声明了 generate_audio 支持且默认开（真实能力，不是默认值补齐）。
        expect(profile?.generateAudio).toEqual({ supported: true, default: true });
    });

    test("never deletes local manual models or their prices, even when the whole directory is fresh", () => {
        const manual = configuredCost("manual/kept-image", "image", "openai-image", {
            unitPriceMicrocredits: 999_000,
            capabilityConfig: { version: 1, image: { references: { promptMaxChars: 1000, maxImages: 1, maxImageBytes: 1024, maskSupported: false }, size: { parameter: "none", values: [], default: "", allowCustom: false }, resolution: { supported: true, values: ["4k"], default: "4k" }, quality: { supported: false, values: [], default: "auto" }, transparentBackground: { supported: false, default: false }, responseFormat: { supported: false }, outputFormat: { supported: false }, maxOutputs: 1 } },
        });
        const alias = configuredCost("dreamina-image-3.0", "image", "openai-image", { unitPriceMicrocredits: 1_000 });
        const directoryRow = configuredCost("dreamina/5.0", "image", "dreamina-cli-image");
        const result = applyFetchedChannelModelCatalog(channelWith([directoryRow, manual, alias]), catalogFor("dreamina/5.0"));
        // 目录里没有的本地手配行：模型、价格、能力一字不动。
        expect(result.modelCosts.find((cost) => cost.model === "manual/kept-image")).toEqual(manual);
        expect(result.models).toContain("manual/kept-image");
        expect(result.models).toContain("dreamina/5.0");
        // 目录条目只改自己的 capabilityConfig，价格不变。
        expect(result.modelCosts.find((cost) => cost.model === "dreamina/5.0")?.unitPriceMicrocredits).toBe(250_000);
    });

    test("reports the real stale and unavailable rows and keeps the configured prices", () => {
        const stale = configuredCost("dreamina/4.0", "image", "dreamina-cli-image");
        const unavailable = configuredCost("libtv/wan-2.2", "video", "libtv-video");
        const result = applyFetchedChannelModelCatalog(channelWith([stale, unavailable]), catalogFor("dreamina/4.0", "libtv/wan-2.2"));
        expect(result.skipped).toEqual([
            { model: "dreamina/4.0", reason: "网关能力已过期（stale）" },
            { model: "libtv/wan-2.2", reason: "网关暂未提供该模型能力（unavailable）" },
        ]);
        expect(result.modelCosts.find((cost) => cost.model === "dreamina/4.0")).toEqual(stale);
        expect(result.modelCosts.find((cost) => cost.model === "libtv/wan-2.2")).toEqual(unavailable);
        expect(result.modelCosts.some((cost) => cost.capabilityConfig?.image || cost.capabilityConfig?.video)).toBe(false);
    });

    test("a capabilityConfig without usable metadata is reported instead of falling back to legacy inference", () => {
        const withoutMeta = catalogFromFixture((record) => {
            const cloned = { ...record };
            delete cloned.capabilityMeta;
            return cloned;
        });
        const configured = configuredCost("dreamina/5.0", "image", "dreamina-cli-image", {
            capabilityConfig: { version: 1, image: { references: { promptMaxChars: 1, maxImages: 1, maxImageBytes: 1, maskSupported: false }, size: { parameter: "none", values: [], default: "", allowCustom: false }, resolution: { supported: true, values: ["4k"], default: "4k" }, quality: { supported: false, values: [], default: "auto" }, transparentBackground: { supported: false, default: false }, responseFormat: { supported: false }, outputFormat: { supported: false }, maxOutputs: 1 } },
        });
        const result = applyFetchedChannelModelCatalog(channelWith([configured]), withoutMeta);
        expect(result.skipped).toContainEqual({ model: "dreamina/5.0", reason: "目录未声明能力元信息（capabilityMeta）" });
        // 手配能力没有被 legacy 默认值覆盖。
        expect(result.modelCosts.find((cost) => cost.model === "dreamina/5.0")).toEqual(configured);
        // 未配置行同样不落 legacy：没有明确协议就不新建行，也不推断 newapi/openai-image。
        expect(result.modelCosts.find((cost) => cost.model === "libtv/seedream-4")).toBeUndefined();
        expect(result.skipped).toContainEqual({ model: "libtv/seedream-4", reason: "目录未声明能力元信息（capabilityMeta）" });
    });

    test("keeps models and modelCosts from the same filtered candidates", () => {
        const richIds = new Set(RICH_IDS);
        const withoutProtocol = applyFetchedChannelModelCatalog(channelWith([]), catalogFromFixture());
        const skippedIds = new Set(withoutProtocol.skipped.map((entry) => entry.model));
        for (const cost of withoutProtocol.modelCosts) {
            expect(withoutProtocol.models).toContain(cost.model);
        }
        // 没选插件时没有任何富条目能应用：它们既不进 models 也不进 modelCosts。
        expect(withoutProtocol.modelCosts).toEqual([]);
        expect(withoutProtocol.models.filter((model) => richIds.has(model))).toEqual([]);
        expect(withoutProtocol.models).not.toContain("dreamina/4.0");
        expect(withoutProtocol.models).not.toContain("libtv/wan-2.2");
        const declaredCount = catalogFromFixture().filter((item) => item.capabilityDeclared).length;
        expect(skippedIds.size).toBe(declaredCount);

        const applied = applyFetchedChannelModelCatalog(channelWith([]), catalogFromFixture(), { selectedProtocol: "qcreate-cli-image" });
        for (const cost of applied.modelCosts) {
            expect(applied.models).toContain(cost.model);
        }
        // 选中的协议与前缀无关，按逐条协议精确匹配：只有 qcreate 的图片模型进候选。
        expect(applied.modelCosts.map((cost) => cost.model)).toEqual(["qcreate/qwen3"]);
        expect(applied.models).toContain("qcreate/qwen3");
        expect(applied.models).not.toContain("dreamina/5.0");
    });

    test("treats the entry=None projection as declared-but-unavailable, never as a legacy row", () => {
        const raw = recordById.get("dreamina/seedance-2.0") as Record<string, unknown>;
        // 真实宿主形状：protocol 为空串，meta 带空 sourceVersion 与 null refreshedAt。
        expect(raw).toMatchObject({ modelType: "video", protocol: "" });
        expect(raw.capabilityConfig).toBeNull();
        expect(raw.capabilityMeta).toEqual({ schemaVersion: 1, revision: 12, status: "unavailable", sourceVersion: "", refreshedAt: null });

        const item = sanitizeChannelModelCatalogItem(raw);
        // 合法但「没有版本信息」的 unavailable meta 必须留下来，否则会滑回旧目录推断。
        expect(item?.capabilityMeta).toEqual({ schemaVersion: 1, revision: 12, status: "unavailable" });
        expect(item?.capabilityDeclared).toBe(true);

        const configured = configuredCost("dreamina/seedance-2.0", "video", "dreamina-cli-video", {
            capabilityConfig: { version: 1, video: { references: { promptMaxChars: 1, minImages: 0, maxImages: 0, maxImageBytes: 0, maxVideos: 0, maxVideoBytes: 0, maxVideoDurationSeconds: 0, maxAudios: 0, maxAudioBytes: 0, maxAudioDurationSeconds: 0 }, duration: { selection: "range", min: 1, max: 2, step: 1, default: 1 }, ratios: ["1:1"], defaultRatio: "1:1", resolutions: ["720p"], defaultResolution: "720p", generateAudio: { supported: false, default: false }, watermark: { supported: false, default: false }, operations: ["text_to_video"], defaultOperation: "text_to_video" } },
        });
        const result = applyFetchedChannelModelCatalog(channelWith([configured]), catalogFor("dreamina/seedance-2.0"));
        expect(result.skipped).toEqual([{ model: "dreamina/seedance-2.0", reason: "网关暂未提供该模型能力（unavailable）" }]);
        expect(result.modelCosts).toEqual([configured]);
        expect(result.models).toContain("dreamina/seedance-2.0");
    });

    test("never falls back to legacy inference when the capability metadata is damaged", () => {
        const realImage = recordById.get("dreamina/5.0") as { capabilityConfig: ModelCapabilityConfig };
        const variants: Array<[string, Record<string, unknown>, string]> = [
            ["missing meta", { capabilityConfig: realImage.capabilityConfig }, "目录未声明能力元信息（capabilityMeta）"],
            ["bad version", { capabilityConfig: realImage.capabilityConfig, capabilityMeta: { schemaVersion: "1", revision: 12, status: "fresh" } }, "目录未声明能力元信息（capabilityMeta）"],
            ["unknown status", { capabilityConfig: realImage.capabilityConfig, capabilityMeta: { schemaVersion: 1, revision: 12, status: "freshy" } }, "目录未声明能力元信息（capabilityMeta）"],
            ["empty meta", { capabilityMeta: {} }, "目录未声明能力元信息（capabilityMeta）"],
            ["unsupported schema", { capabilityConfig: realImage.capabilityConfig, capabilityMeta: { schemaVersion: 2, revision: 12, status: "fresh" } }, "不支持的能力契约版本 v2"],
        ];
        for (const [label, patch, reason] of variants) {
            const item = sanitizeChannelModelCatalogItem({ id: "dreamina/5.0", modelType: "image", protocol: "dreamina-cli-image", ...patch });
            expect(item, label).not.toBeNull();
            // 声明过就一定是「声明过」，哪怕字段全坏。
            expect(item?.capabilityDeclared, label).toBe(true);
            const empty = applyFetchedChannelModelCatalog(channelWith([]), [item as ChannelModelCatalogItem], { selectedProtocol: "dreamina-cli-image" });
            expect(empty.skipped, label).toEqual([{ model: "dreamina/5.0", reason }]);
            expect(empty.modelCosts, label).toEqual([]);
            expect(empty.models, label).toEqual([]);
        }
    });

    test("keeps the real quality tiers usable as resolution tiers without inventing a resolution field", () => {
        const cases: Array<[string, string, string[]]> = [
            ["dreamina/5.0", "dreamina-cli-image", ["2k", "4k"]],
            ["libtv/seedream-4", "libtv-image", ["2k", "4k"]],
            ["qcreate/qwen3", "qcreate-cli-image", ["1K", "1.5K", "2K"]],
        ];
        for (const [id, protocol, qualityValues] of cases) {
            const result = applyFetchedChannelModelCatalog(channelWith([configuredCost(id, "image", protocol)]), catalogFor(id));
            const profile = readProfile(result.modelCosts[0] as ModelChannelCost).image;
            expect(profile?.quality, id).toEqual({ supported: true, values: qualityValues, default: qualityValues[0] === "1K" ? "1K" : "2k" });
            // 宿主把上游的清晰度档折进了 quality：读路径据此把档位映射到质量值，不伪造 resolution。
            expect(profile?.resolution.supported, id).toBe(false);
            expect(imageResolutionUsesQuality(profile!), id).toBe(true);
            expect(imageQualityForSelection(profile!, "2k"), id).toBe(qualityValues.includes("2k") ? "2k" : "2K");
            expect(imageTierAvailable(profile!, "1k"), id).toBe(qualityValues.some((value) => ["1k", "1.5k"].includes(value.toLowerCase())));
            // 尺寸选择器必须有可选项（宿主 ImageSizeConfig.presets 为空数组不能清空它）。
            const presets = imageSizePresets(profile!).filter((preset) => imageTierAvailable(profile!, preset.tier));
            expect(presets.length, id).toBeGreaterThan(0);
            for (const preset of presets) expect(imageResolutionTiers(profile!), id).toContain(preset.tier);
        }
    });

    test("reads the host payload end to end through fetchChannelModels and then applies it", async () => {
        axios.request = (async () => ({ data: { object: "list", data: records } })) as unknown as typeof axios.request;
        // 系统渠道走同一条 sanitize 路径但不查插件目录（插件鉴权由 personal-browser-generation 覆盖）。
        const channel = channelWith([], { scope: "system" });
        const fetched = await fetchChannelModels(channel, false);
        expect(fetched.catalog.filter((item) => item.capabilityConfig).length).toBe(RICH_IDS.length);
        expect(fetched.models).toContain("dreamina/5.0");
        const result = applyFetchedChannelModelCatalog(channelWith([]), fetched.catalog, { selectedProtocol: "dreamina-cli-image" });
        // 明确选定插件后，只有同协议的 fresh 模型可以新建行；别家插件与视频条目仍然待配置。
        expect(result.modelCosts.map((cost) => [cost.model, cost.protocol, cost.capability])).toEqual([
            ["dreamina/5.0", "dreamina-cli-image", "image"],
        ]);
        expect(result.skipped).toContainEqual({ model: "dreamina/3.0-pro", reason: "协议不匹配（目录 dreamina-cli-video ≠ 渠道 dreamina-cli-image）" });
        expect(result.skipped).toContainEqual({ model: "qcreate/qwen3", reason: "协议不匹配（目录 qcreate-cli-image ≠ 渠道 dreamina-cli-image）" });
    });
});
