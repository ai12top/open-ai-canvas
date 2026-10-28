import { applicableChannelCapability, capabilityKindOf, sanitizeChannelCapabilityConfig, sanitizeChannelCapabilityMeta, type ChannelCapabilityMeta } from "@/lib/capability-catalog";
import { defaultModelCapabilityConfig, type ModelCapabilityConfig } from "@/lib/model-capabilities";
import { modelProtocolCapability, protocolForModelCatalog, type ModelProtocol } from "@/lib/model-protocols";
import type { ModelChannel } from "@/stores/use-config-store";

export type ChannelModelCatalogOption = { value: string; label?: string };

export type ChannelModelCatalogItem = {
    id: string;
    displayName?: string;
    modelType?: "text" | "image" | "video" | "audio";
    supportedEndpointTypes?: string[];
    defaultParameters?: {
        aspectRatio?: string;
        durationSeconds?: string;
        resolution?: string;
    };
    options?: {
        aspectRatio?: ChannelModelCatalogOption[];
        durationSeconds?: ChannelModelCatalogOption[];
        resolution?: ChannelModelCatalogOption[];
    };
    supportsImages?: boolean;
    minImages?: number;
    maxImages?: number;
    /** 网关声明的协议（已安装插件 provider ID）；只用于兼容匹配，不用于推断。 */
    protocol?: string;
    /** 网关能力元信息；只有 schemaVersion 受支持且 fresh 的条目才允许应用能力。 */
    capabilityMeta?: ChannelCapabilityMeta;
    /** 已校验的整份能力配置；null/缺失表示网关没有可应用的能力。 */
    capabilityConfig?: ModelCapabilityConfig;
    /**
     * 原始条目声明过能力字段（capabilityMeta / protocol / capabilityConfig 任一），
     * 哪怕它们全都没通过校验。用来保证损坏的富条目走「无法应用 + 原因」而从不退到旧目录推断。
     */
    capabilityDeclared?: true;
};

type ChannelModelCost = NonNullable<ModelChannel["modelCosts"]>[number];

export function sanitizeChannelModelCatalogItem(value: unknown): ChannelModelCatalogItem | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const id = stringValue(record.id);
    if (!id) return null;
    const modelType = stringValue(record.modelType).toLowerCase();
    const defaultParameters = objectValue(record.defaultParameters);
    const options = objectValue(record.options);
    const normalizedDefaults = defaultParameters
        ? {
              ...(stringValue(defaultParameters.aspectRatio) ? { aspectRatio: stringValue(defaultParameters.aspectRatio) } : {}),
              ...(stringValue(defaultParameters.durationSeconds) ? { durationSeconds: stringValue(defaultParameters.durationSeconds) } : {}),
              ...(stringValue(defaultParameters.resolution) ? { resolution: stringValue(defaultParameters.resolution) } : {}),
          }
        : undefined;
    const normalizedOptions = options
        ? {
              ...(catalogOptions(options.aspectRatio).length ? { aspectRatio: catalogOptions(options.aspectRatio) } : {}),
              ...(catalogOptions(options.durationSeconds).length ? { durationSeconds: catalogOptions(options.durationSeconds) } : {}),
              ...(catalogOptions(options.resolution).length ? { resolution: catalogOptions(options.resolution) } : {}),
          }
        : undefined;
    const normalizedModelType = ["text", "image", "video", "audio"].includes(modelType) ? (modelType as ChannelModelCatalogItem["modelType"]) : undefined;
    const protocol = stringValue(record.protocol);
    // 先记住「这条声明过能力」，再看能不能用：损坏的声明不能被当成旧目录条目。
    const capabilityDeclared = ["capabilityMeta", "protocol", "capabilityConfig"].some((key) => record[key] !== undefined);
    return compactCatalogItem({
        id,
        displayName: stringValue(record.displayName),
        modelType: normalizedModelType,
        supportedEndpointTypes: stringArray(record.supportedEndpointTypes),
        defaultParameters: normalizedDefaults,
        options: normalizedOptions,
        supportsImages: typeof record.supportsImages === "boolean" ? record.supportsImages : undefined,
        minImages: nonNegativeInteger(record.minImages),
        maxImages: nonNegativeInteger(record.maxImages),
        protocol: protocol && protocol.length <= 120 ? protocol : undefined,
        // 外部 JSON 一律先校验再收窄：校验失败的能力不会被归一化函数“修复”成看似可用的能力。
        capabilityMeta: sanitizeChannelCapabilityMeta(record.capabilityMeta) || undefined,
        capabilityConfig: sanitizeChannelCapabilityConfig(normalizedModelType, record.capabilityConfig) || undefined,
        capabilityDeclared: capabilityDeclared ? true : undefined,
    });
}

export type ChannelModelSkip = { model: string; reason: string };

export type ChannelModelApplyResult = {
    models: string[];
    modelCosts: ChannelModelCost[];
    /** 目录没应用（或应用失败）的原因，供界面如实展示。 */
    skipped: ChannelModelSkip[];
};

/**
 * 把一次拉取结果合并进渠道。
 *
 * - 旧目录（只有 id / modelType / endpoint 元数据）：逐字保留原有推断行为。
 * - 富目录（网关声明了 protocol / capabilityMeta / capabilityConfig 之一）：只接受契约版本
 *   受支持、fresh、类型/协议完全匹配的整份能力配置；其余条目不动已有的手配、价格、凭据与
 *   启用状态。声明了能力却缺 meta / meta 损坏的条目按「无法应用」处理，绝不 fail-open
 *   退回旧目录的推断/默认值路径。
 * - 目录里的旧行永远不删：fresh 只替换同一 ID 的能力，本地手动行及其价格全部保留。
 */
export function applyFetchedChannelModelCatalog(
    channel: ModelChannel,
    catalog: ChannelModelCatalogItem[],
    options: { selectedProtocol?: string } = {},
): ChannelModelApplyResult {
    const selectedProtocol = (options.selectedProtocol || "").trim() || undefined;
    const entries = uniqueCatalogEntries(catalog);
    const entryIds = new Set(entries.map((item) => item.id));
    const existingByModel = new Map((channel.modelCosts || []).map((cost) => [cost.model, cost]));
    const modelCosts: ChannelModelCost[] = [];
    const skipped: ChannelModelSkip[] = [];
    const keptIds = new Set<string>();
    for (const item of entries) {
        const existing = existingByModel.get(item.id);
        if (existing) {
            modelCosts.push(mergeExistingCatalogCost(channel, item, existing, skipped));
            keptIds.add(item.id);
            continue;
        }
        const created = createCatalogCost(channel, item, selectedProtocol, skipped);
        if (created) {
            modelCosts.push(created);
            keptIds.add(item.id);
        }
    }
    const declaresCapabilities = entries.some(declaresCapabilityEntry);
    // models 只收下来的条目：富条目没应用就不会只出现在 models 里而没有对应配置；
    // 目录契约外的旧条目保持原有行为。
    let models = entries.filter((item) => !declaresCapabilityEntry(item) || keptIds.has(item.id)).map((item) => item.id);
    if (declaresCapabilities) {
        // 能力目录无权删本地行：这一轮没返回（或没应用）的已有模型连同价格一律原样保留，
        // 不论整份目录是不是 fresh —— fresh 只代表「同 ID 的能力可以整份替换」。
        for (const cost of channel.modelCosts || []) {
            if (entryIds.has(cost.model)) continue;
            modelCosts.push(cost);
            entryIds.add(cost.model);
        }
        models = Array.from(new Set([...models, ...(channel.models || []), ...modelCosts.map((cost) => cost.model)]));
    }
    return { models: Array.from(new Set(models)).sort((a, b) => a.localeCompare(b)), modelCosts, skipped };
}

/** 兼容旧调用：只关心合并后的每模型配置时用这个。 */
export function mergeFetchedChannelModelCosts(channel: ModelChannel, catalog: ChannelModelCatalogItem[]): ChannelModelCost[] {
    return applyFetchedChannelModelCatalog(channel, catalog).modelCosts;
}

function declaresCapabilityEntry(item: ChannelModelCatalogItem) {
    // capabilityDeclared 兜住了「声明过能力但字段全损坏」的条目；capabilityConfig 兜住了
    // 「没有 meta / meta 损坏但 config 仍在」的条目：两者都必须走「无法应用 + 原因」，
    // 不能 fallback 到旧目录的协议推断 + 默认档位（不能 fail-open）。
    return Boolean(item.capabilityDeclared || item.capabilityMeta || item.protocol || item.capabilityConfig);
}

function uniqueCatalogEntries(catalog: ChannelModelCatalogItem[]) {
    const entries = new Map<string, ChannelModelCatalogItem>();
    for (const item of catalog) {
        if (!entries.has(item.id)) entries.set(item.id, item);
    }
    return Array.from(entries.values());
}

function mergeExistingCatalogCost(channel: ModelChannel, item: ChannelModelCatalogItem, existing: ChannelModelCost, skipped: ChannelModelSkip[]): ChannelModelCost {
    if (!declaresCapabilityEntry(item)) return mergeLegacyExistingCost(channel, item, existing);
    const withDisplayName = item.displayName ? { ...existing, displayName: item.displayName } : existing;
    const kind = capabilityKindOf(item.modelType);
    if (kind && existing.capability !== kind) {
        skipped.push({ model: item.id, reason: `目录声明的模型类型（${kind}）与已配置能力（${existing.capability}）不一致` });
        return withDisplayName;
    }
    // 已配置行以自己的协议为准（不能只看 channel.interfaceType），且不做任何回退推断。
    const gate = applicableChannelCapability(item, existing.protocol);
    if (!gate.applied) {
        skipped.push({ model: item.id, reason: gate.reason });
        return withDisplayName;
    }
    // 能力整份替换（不是并集）：价格、计费、凭据、启用状态、可用性都不参与改写。
    return { ...withDisplayName, capabilityConfig: gate.config };
}

function createCatalogCost(
    channel: ModelChannel,
    item: ChannelModelCatalogItem,
    selectedProtocol: string | undefined,
    skipped: ChannelModelSkip[],
): ChannelModelCost | undefined {
    if (declaresCapabilityEntry(item)) {
        // 未配置行只认用户明确选定的已装插件协议；没有明确协议就保留待配置，不新建行。
        const gate = applicableChannelCapability(item, selectedProtocol);
        if (!gate.applied) {
            skipped.push({ model: item.id, reason: gate.reason });
            return undefined;
        }
        return {
            model: item.id,
            ...(item.displayName ? { displayName: item.displayName } : {}),
            capability: gate.kind,
            protocol: (item.protocol || "").trim(),
            billingMode: "fixed_request",
            unitPriceMicrocredits: 0,
            capabilityConfig: gate.config,
        };
    }
    // 目录契约之外的 OpenAI/Gemini/系统目录：保持既有协议推断行为。
    const inferredProtocol = protocolForModelCatalog(item.supportedEndpointTypes);
    const inferredCapability = modelProtocolCapability(inferredProtocol) || item.modelType;
    const capability = inferredCapability || modelProtocolCapability(channel.interfaceType);
    const protocol = inferredProtocol || protocolTemplateForNewCatalogModel(capability, channel.interfaceType);
    if (!protocol || !capability) return undefined;
    const capabilityConfig = capability === "image" || capability === "video" ? catalogCapabilityConfig(item, protocol, capability, undefined, true) : undefined;
    return {
        model: item.id,
        ...(item.displayName ? { displayName: item.displayName } : {}),
        capability,
        protocol,
        billingMode: "fixed_request",
        unitPriceMicrocredits: 0,
        ...(capabilityConfig ? { capabilityConfig } : {}),
    };
}

function mergeLegacyExistingCost(channel: ModelChannel, item: ChannelModelCatalogItem, existing: ChannelModelCost): ChannelModelCost {
    const inferredProtocol = protocolForModelCatalog(item.supportedEndpointTypes);
    const inferredCapability = modelProtocolCapability(inferredProtocol) || item.modelType;
    const protocol = inferredProtocol || existing.protocol;
    const capability = inferredCapability || existing.capability;
    const capabilityChanged = capability !== existing.capability;
    const patchCapabilityConfig = hasCatalogCapabilityConfig(item) && (capability === "image" || capability === "video");
    const capabilityConfig = patchCapabilityConfig
        ? catalogCapabilityConfig(item, protocol || channel.interfaceType, capability, capabilityChanged ? undefined : existing.capabilityConfig, false)
        : capabilityChanged
          ? undefined
          : existing.capabilityConfig;
    return {
        ...existing,
        ...(item.displayName ? { displayName: item.displayName } : {}),
        capability,
        ...(inferredProtocol ? { protocol: inferredProtocol } : {}),
        ...(patchCapabilityConfig || capabilityChanged ? { capabilityConfig } : {}),
    };
}

function protocolTemplateForNewCatalogModel(capability: ChannelModelCost["capability"] | undefined, channelProtocol: ModelProtocol | undefined): ModelProtocol | undefined {
    if (!capability) return channelProtocol;
    if (modelProtocolCapability(channelProtocol) === capability) return channelProtocol;
    const templates: Record<ChannelModelCost["capability"], ModelProtocol> = { text: "chat-completion", image: "openai-image", video: "newapi", audio: "openai-audio" };
    return templates[capability];
}

function hasCatalogCapabilityConfig(item: ChannelModelCatalogItem) {
    return Boolean(item.defaultParameters || item.options || item.supportsImages !== undefined || item.minImages !== undefined || item.maxImages !== undefined);
}

function catalogCapabilityConfig(item: ChannelModelCatalogItem, protocol: ModelProtocol | undefined, capability: "image" | "video", existing: ModelCapabilityConfig | undefined, isNew: boolean): ModelCapabilityConfig {
    const fallback = defaultModelCapabilityConfig(protocol, item.id);
    const existingProfile = capability === "image" ? existing?.image : existing?.video;
    const config = structuredClone(existingProfile ? existing! : fallback);
    if (capability === "image") {
        if (item.supportsImages === false) config.image!.references.maxImages = 0;
        else if (item.maxImages !== undefined) config.image!.references.maxImages = item.maxImages;
        return config;
    }

    const video = config.video!;
    if (isNew) {
        video.resolutions = [];
        video.defaultResolution = "";
    }
    const durations = uniqueNumbers(optionValues(item.options?.durationSeconds));
    const defaultDuration = positiveNumber(item.defaultParameters?.durationSeconds);
    if (durations.length) {
        video.duration = { selection: "enum", values: durations, default: durations.includes(defaultDuration) ? defaultDuration : durations[0]! };
    } else if (defaultDuration > 0) {
        video.duration = { selection: "enum", values: [defaultDuration], default: defaultDuration };
    }
    const ratios = optionValues(item.options?.aspectRatio);
    const defaultRatio = item.defaultParameters?.aspectRatio?.trim() || "";
    if (ratios.length) {
        video.ratios = ratios;
        video.defaultRatio = ratios.includes(defaultRatio) ? defaultRatio : ratios[0]!;
    } else if (defaultRatio) {
        video.ratios = [defaultRatio];
        video.defaultRatio = defaultRatio;
    }

    // A catalog-backed video may only emit resolution_name when the provider
    // explicitly advertises compatible values. An empty list means omit it.
    const resolutions = optionValues(item.options?.resolution);
    const defaultResolution = item.defaultParameters?.resolution?.trim() || "";
    if (resolutions.length || defaultResolution) {
        video.resolutions = resolutions.length ? resolutions : [defaultResolution];
        video.defaultResolution = video.resolutions.includes(defaultResolution) ? defaultResolution : video.resolutions[0] || "";
    }

    if (item.supportsImages === false || item.maxImages === 0) {
        video.references.minImages = 0;
        video.references.maxImages = 0;
        video.operations = video.operations.filter((operation) => operation !== "image_to_video");
        if (!video.operations.length) video.operations = ["text_to_video"];
        video.defaultOperation = video.operations.includes(video.defaultOperation) ? video.defaultOperation : video.operations[0]!;
    } else {
        if (item.maxImages !== undefined) video.references.maxImages = item.maxImages;
        if (item.minImages !== undefined) video.references.minImages = item.minImages;
        if (video.references.minImages > 0) {
            video.references.maxImages = Math.max(video.references.minImages, video.references.maxImages);
            video.operations = video.operations.filter((operation) => operation !== "text_to_video");
            if (!video.operations.includes("image_to_video")) video.operations.unshift("image_to_video");
            video.defaultOperation = "image_to_video";
        }
    }
    return config;
}

function compactCatalogItem(item: ChannelModelCatalogItem): ChannelModelCatalogItem {
    const defaultParameters = item.defaultParameters && Object.values(item.defaultParameters).some(Boolean) ? item.defaultParameters : undefined;
    const options = item.options && Object.values(item.options).some((values) => values?.length) ? item.options : undefined;
    return {
        id: item.id,
        ...(item.displayName ? { displayName: item.displayName } : {}),
        ...(item.modelType ? { modelType: item.modelType } : {}),
        ...(item.supportedEndpointTypes?.length ? { supportedEndpointTypes: item.supportedEndpointTypes } : {}),
        ...(defaultParameters ? { defaultParameters } : {}),
        ...(options ? { options } : {}),
        ...(item.supportsImages !== undefined ? { supportsImages: item.supportsImages } : {}),
        ...(item.minImages !== undefined ? { minImages: item.minImages } : {}),
        ...(item.maxImages !== undefined ? { maxImages: item.maxImages } : {}),
        ...(item.protocol ? { protocol: item.protocol } : {}),
        ...(item.capabilityMeta ? { capabilityMeta: item.capabilityMeta } : {}),
        ...(item.capabilityConfig ? { capabilityConfig: item.capabilityConfig } : {}),
        ...(item.capabilityDeclared ? { capabilityDeclared: item.capabilityDeclared } : {}),
    };
}

function objectValue(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown) {
    return Array.isArray(value) ? Array.from(new Set(value.map(stringValue).filter(Boolean))) : [];
}

function catalogOptions(value: unknown): ChannelModelCatalogOption[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const options: ChannelModelCatalogOption[] = [];
    for (const raw of value) {
        const record = objectValue(raw);
        const optionValue = stringValue(record?.value);
        if (!optionValue || seen.has(optionValue)) continue;
        seen.add(optionValue);
        const label = stringValue(record?.label);
        options.push({ value: optionValue, ...(label ? { label } : {}) });
    }
    return options;
}

function optionValues(options: ChannelModelCatalogOption[] | undefined) {
    return Array.from(new Set((options || []).map((option) => option.value.trim()).filter(Boolean)));
}

function positiveNumber(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function uniqueNumbers(values: string[]) {
    return Array.from(new Set(values.map(positiveNumber).filter((value) => value > 0)));
}

function nonNegativeInteger(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
