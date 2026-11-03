import { describe, expect, test } from "bun:test";

import {
    channelCatalogImportReason,
    importSelectedChannelModels,
    refreshConfiguredChannelModels,
    type ChannelModelCatalogItem,
} from "../src/lib/channel-model-catalog";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import type { ModelProtocolDefinition } from "../src/lib/model-protocols";
import { createModelChannel, type ModelChannel } from "../src/stores/use-config-store";

type ChannelCost = NonNullable<ModelChannel["modelCosts"]>[number];

const freshMeta = (status: "fresh" | "stale" = "fresh") => ({ schemaVersion: 1, revision: 4, status, sourceVersion: "test", refreshedAt: 1_761_600_000 });
const protocol = (value: string, capability: ModelProtocolDefinition["capability"], options: Partial<ModelProtocolDefinition> = {}): ModelProtocolDefinition => ({
    value,
    capability,
    label: value,
    create: "POST /test",
    contentType: "application/json",
    media: "url",
    ...options,
});
const protocols = [
    protocol("openai-image", "image"),
    protocol("browser-video", "video", { browserManifest: { version: 1 } }),
    protocol("other-video", "video"),
];

function rich(id: string, protocolId = "openai-image", status: "fresh" | "stale" = "fresh"): ChannelModelCatalogItem {
    const capability = protocolId.includes("video") ? "video" : "image";
    return {
        id,
        displayName: `目录 ${id}`,
        modelType: capability,
        protocol: protocolId,
        capabilityMeta: freshMeta(status),
        capabilityConfig: defaultModelCapabilityConfig(protocolId, id),
    };
}

function legacy(id: string, overrides: Partial<ChannelModelCatalogItem> = {}): ChannelModelCatalogItem {
    return { id, displayName: `旧目录 ${id}`, modelType: "image", ...overrides };
}

function channel(models: string[], modelCosts: ChannelCost[] = [], overrides: Partial<ModelChannel> = {}) {
    return createModelChannel({
        id: "personal",
        name: "个人渠道",
        baseUrl: "http://127.0.0.1:8123/v1",
        apiKey: "test",
        apiFormat: "openai",
        models,
        modelCosts,
        ...overrides,
    });
}

function cost(model: string, overrides: Partial<ChannelCost> = {}): ChannelCost {
    return { model, capability: "image", protocol: "openai-image", billingMode: "fixed_request", unitPriceMicrocredits: 12, ...overrides };
}

describe("personal channel model selection", () => {
    test("refresh updates only existing models, keeps order, and reports missing entries", () => {
        const configured = cost("keep", { unitPriceMicrocredits: 99, available: false });
        const manual = cost("manual", { protocol: "browser-video", capability: "video", unitPriceMicrocredits: 7 });
        const current = channel(["keep", "manual", "missing"], [configured, manual]);
        const result = refreshConfiguredChannelModels(current, [rich("keep"), rich("manual", "browser-video")]);

        expect(result.models).toEqual(["keep", "manual", "missing"]);
        expect(result.modelCosts.map((item) => item.model)).toEqual(["keep", "manual"]);
        expect(result.modelCosts[0]?.unitPriceMicrocredits).toBe(99);
        expect(result.modelCosts[0]?.available).toBe(false);
        expect(result.modelCosts[0]?.capabilityConfig).toEqual(rich("keep").capabilityConfig);
        expect(result.modelCosts[1]?.protocol).toBe("browser-video");
        expect(result.skipped).toEqual([{ model: "missing", reason: "网关目录未返回该模型，已保留本地配置" }]);
    });

    test("refresh does not add catalog models and keeps a hand-configured cost absent from the directory", () => {
        const manual = cost("manual", { unitPriceMicrocredits: 77 });
        const current = channel(["manual"], [manual]);
        const result = refreshConfiguredChannelModels(current, [rich("new-model"), rich("manual")]);

        expect(result.models).toEqual(["manual"]);
        expect(result.modelCosts).toHaveLength(1);
        expect(result.modelCosts[0]?.unitPriceMicrocredits).toBe(77);
    });

    test("refresh skips rich entries without a configured cost or protocol", () => {
        const current = channel(["no-cost", "no-protocol"], [cost("no-protocol", { protocol: undefined })]);
        const result = refreshConfiguredChannelModels(current, [rich("no-cost"), rich("no-protocol")]);

        expect(result.models).toEqual(["no-cost", "no-protocol"]);
        expect(result.modelCosts).toEqual([cost("no-protocol", { protocol: undefined })]);
        expect(result.skipped.map((item) => item.model)).toEqual(["no-cost", "no-protocol"]);
    });

    test("refreshing a legacy row never changes the user's protocol or capability", () => {
        const configured = cost("legacy", { protocol: "browser-video", capability: "video", capabilityConfig: undefined });
        const result = refreshConfiguredChannelModels(channel(["legacy"], [configured]), [legacy("legacy", { modelType: "image", options: { aspectRatio: [{ value: "1:1" }] } })]);

        expect(result.modelCosts[0]?.protocol).toBe("browser-video");
        expect(result.modelCosts[0]?.capability).toBe("video");
        expect(result.modelCosts[0]?.capabilityConfig?.video?.ratios).toEqual(["1:1"]);
    });

    test("import adds only explicitly selected new IDs and preserves existing order and costs", () => {
        const existing = cost("existing", { unitPriceMicrocredits: 88 });
        const result = importSelectedChannelModels(
            channel(["existing"], [existing]),
            [rich("existing"), rich("selected"), rich("not-selected")],
            ["selected"],
            protocols,
        );

        expect(result.models).toEqual(["existing", "selected"]);
        expect(result.modelCosts.map((item) => item.model)).toEqual(["existing", "selected"]);
        expect(result.modelCosts[0]?.unitPriceMicrocredits).toBe(88);
        expect(result.modelCosts[1]?.protocol).toBe("openai-image");
        expect(result.skipped).toEqual([]);
    });

    test("import applies the directory protocol only after installed-provider and capability checks", () => {
        const result = importSelectedChannelModels(
            channel([]),
            [rich("browser", "browser-video"), rich("uninstalled", "missing-video"), { ...rich("wrong-kind", "openai-image"), modelType: "video" }],
            ["browser", "uninstalled", "wrong-kind"],
            protocols,
        );

        expect(result.models).toEqual(["browser"]);
        expect(result.modelCosts[0]?.protocol).toBe("browser-video");
        expect(result.skipped.map((item) => item.model)).toEqual(["uninstalled", "wrong-kind"]);
        expect(result.skipped[0]?.reason).toContain("未安装");
        expect(result.skipped[1]?.reason).toContain("协议能力不匹配");
    });

    test("import allows an explicitly selected legacy ID without inventing a cost", () => {
        const result = importSelectedChannelModels(channel([], [], { interfaceType: undefined }), [legacy("legacy-id", { modelType: undefined })], ["legacy-id"], protocols);

        expect(result.models).toEqual(["legacy-id"]);
        expect(result.modelCosts).toEqual([]);
        expect(result.skipped).toEqual([]);
    });

    test("import rejects stale, malformed, or unselected rich rows and explains the reason", () => {
        const stale = rich("stale", "openai-image", "stale");
        const malformed = { ...rich("broken"), capabilityConfig: undefined };
        const result = importSelectedChannelModels(channel([]), [stale, malformed, rich("other")], ["stale", "broken"], protocols);

        expect(result.models).toEqual([]);
        expect(result.skipped.map((item) => item.model)).toEqual(["stale", "broken"]);
        expect(result.skipped[0]?.reason).toContain("过期");
        expect(result.skipped[1]?.reason).toContain("能力配置");
        expect(result.models).not.toContain("other");
    });

    test("explicitly re-adding a removed model never revives an orphaned cost", () => {
        const current: ModelChannel = { ...channel(["keep"], [cost("keep")]), modelCosts: [cost("keep"), cost("rich", { protocol: "removed-protocol", unitPriceMicrocredits: 99 }), cost("plain")] };
        const result = importSelectedChannelModels(current, [rich("rich"), { id: "plain" }], ["rich", "plain"], protocols);

        expect(result.models).toEqual(["keep", "rich", "plain"]);
        expect(result.modelCosts.map((item) => item.model)).toEqual(["keep", "rich"]);
        expect(result.modelCosts[0]).toEqual(cost("keep"));
        expect(result.modelCosts[1]?.protocol).toBe("openai-image");
        expect(result.modelCosts[1]?.capabilityConfig).toEqual(rich("rich").capabilityConfig);
        expect(result.modelCosts[1]?.unitPriceMicrocredits).toBe(0);
    });

    test("import reason is empty for legacy and rejects disabled or non-browser media providers", () => {
        expect(channelCatalogImportReason(legacy("legacy"), protocols)).toBe("");
        expect(channelCatalogImportReason(rich("disabled", "disabled-video"), [protocol("disabled-video", "video", { enabled: false, browserManifest: { version: 1 } })])).toContain("已禁用");
        expect(channelCatalogImportReason(rich("server-video", "other-video"), protocols)).toContain("浏览器执行");
    });
});
