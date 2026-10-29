import type { ImageParameter, ImageParameterValue } from "@/lib/image-parameters";
import type { ImageCapabilityConfig, ImageResponseFormat, ModelCapabilityConfig, VideoCapabilityConfig, VideoProcessingConfig } from "@/lib/model-capabilities";

/**
 * 网关模型目录里的能力增量（/v1/models 的 capabilityMeta + capabilityConfig）。
 *
 * 这里是外部未知输入的边界：先按结构、边界、媒体类型逐项校验，再把结果交给渠道合并逻辑。
 * 校验失败一律返回 null，绝不调用 normalizeModelCapabilityConfig 之类的归一化函数来"修复"
 * 损坏数据——归一化会补默认值，把坏能力伪装成正确的能力。只有校验通过的数据才允许写进
 * 渠道配置，随后由 modelCapabilityConfigFor 的真实读路径消费。
 */
export const CAPABILITY_SCHEMA_VERSION = 1;

export type ChannelCapabilityStatus = "fresh" | "stale" | "unavailable";
export type ChannelCapabilityKind = "image" | "video";
export type ChannelCapabilityMeta = {
    schemaVersion: number;
    revision: number;
    status: ChannelCapabilityStatus;
    sourceVersion?: string;
    refreshedAt?: number;
};

/** 目录条目里与能力应用有关的字段（结构上兼容 ChannelModelCatalogItem）。 */
export type ChannelCatalogCapabilityEntry = {
    id: string;
    modelType?: string;
    protocol?: string;
    capabilityConfig?: ModelCapabilityConfig;
    capabilityMeta?: ChannelCapabilityMeta;
};

export type ChannelCapabilityGate = { applied: true; kind: ChannelCapabilityKind; config: ModelCapabilityConfig } | { applied: false; reason: string };

const STATUSES: readonly ChannelCapabilityStatus[] = ["fresh", "stale", "unavailable"];
const IMAGE_PARAMETERS: readonly ImageCapabilityConfig["size"]["parameter"][] = ["none", "size", "aspect_ratio"];
const IMAGE_RESPONSE_FORMATS: readonly ImageResponseFormat[] = ["auto", "b64_json", "url"];
const IMAGE_PARAMETER_TYPES: readonly ImageParameter["type"][] = ["string", "number", "integer", "boolean"];
const IMAGE_PARAMETER_ENCODINGS: readonly NonNullable<ImageParameter["encoding"]>[] = ["pixels", "ratio"];
const VIDEO_OPERATIONS: readonly string[] = ["text_to_video", "image_to_video", "audio_to_video", "extend", "reference_to_video", "video_to_video"];
const VIDEO_FPS_POLICIES: readonly VideoProcessingConfig["fpsPolicy"][] = ["keep_source", "user_select"];

const MAX_TEXT_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_VALUES = 200;
const MAX_PARAMETERS = 64;
const MAX_PRESETS = 128;
const MAX_NUMBER = 1_000_000_000;
const MAX_TIMESTAMP = 4_000_000_000;
const MAX_CAPABILITY_JSON = 256 * 1024;

export function capabilityKindOf(modelType: unknown): ChannelCapabilityKind | null {
    const value = typeof modelType === "string" ? modelType.trim().toLowerCase() : "";
    return value === "image" || value === "video" ? value : null;
}

export function sanitizeChannelCapabilityMeta(value: unknown): ChannelCapabilityMeta | null {
    const record = recordOf(value);
    if (!record) return null;
    const schemaVersion = countOf(record.schemaVersion);
    const status = typeof record.status === "string" ? (record.status.trim().toLowerCase() as ChannelCapabilityStatus) : null;
    if (schemaVersion === null || !status || !STATUSES.includes(status)) return null;
    const revision = record.revision === undefined ? 0 : countOf(record.revision);
    if (revision === null) return null;
    const meta: ChannelCapabilityMeta = { schemaVersion, revision, status };
    // 网关对 unavailable 条目会给 sourceVersion: "" / refreshedAt: null（模型从未取得能力），
    // 这是合法的「未提供」而不是损坏：直接丢掉整份 meta 会让条目不进能力门槛而滑向旧目录推断。
    if (record.sourceVersion !== undefined && record.sourceVersion !== null) {
        if (typeof record.sourceVersion !== "string") return null;
        const sourceVersion = record.sourceVersion.trim();
        if (sourceVersion.length > MAX_TEXT_LENGTH) return null;
        if (sourceVersion) meta.sourceVersion = sourceVersion;
    }
    if (record.refreshedAt !== undefined && record.refreshedAt !== null) {
        // refreshedAt 是网关的秒级时间戳（~1.7e9），不能套用普通计数字段的 1e9 上限。
        const refreshedAt = numberIn(record.refreshedAt, 0, MAX_TIMESTAMP);
        if (refreshedAt === null) return null;
        meta.refreshedAt = refreshedAt;
    }
    return meta;
}

/** 只有图片/视频能力会被校验；未知模型类型或结构不符返回 null。 */
export function sanitizeChannelCapabilityConfig(modelType: unknown, value: unknown): ModelCapabilityConfig | null {
    const kind = capabilityKindOf(modelType);
    if (!kind || isOversized(value)) return null;
    const record = recordOf(value);
    if (!record) return null;
    const version = record.version === undefined ? CAPABILITY_SCHEMA_VERSION : countOf(record.version);
    if (version === null || version < 1) return null;
    if (kind === "image") {
        const image = imageCapabilityConfigOf(record.image);
        return image ? { version, image } : null;
    }
    const video = videoCapabilityConfigOf(record.video);
    return video ? { version, video } : null;
}

/**
 * 能力是否允许整份应用到某一行模型。
 *
 * 门槛：契约版本受支持 + fresh + 目录声明了图片/视频类型 + 完整能力配置 + 目录协议与目标协议
 * 完全一致。不满足时返回可读原因，由界面提示用户，不做任何推断或回退。
 */
export function applicableChannelCapability(item: ChannelCatalogCapabilityEntry, targetProtocol: string | undefined): ChannelCapabilityGate {
    const meta = item.capabilityMeta;
    if (!meta) return { applied: false, reason: "目录未声明能力元信息（capabilityMeta）" };
    if (meta.schemaVersion !== CAPABILITY_SCHEMA_VERSION) return { applied: false, reason: `不支持的能力契约版本 v${meta.schemaVersion}` };
    if (meta.status !== "fresh") {
        return { applied: false, reason: meta.status === "stale" ? "网关能力已过期（stale）" : "网关暂未提供该模型能力（unavailable）" };
    }
    const kind = capabilityKindOf(item.modelType);
    if (!kind) return { applied: false, reason: item.modelType ? `目录声明的模型类型 ${item.modelType} 不是图片或视频` : "目录未声明模型类型" };
    if (!item.capabilityConfig) return { applied: false, reason: "目录未返回可用的能力配置（capabilityConfig）" };
    const protocol = typeof item.protocol === "string" ? item.protocol.trim() : "";
    if (!protocol) return { applied: false, reason: "目录未声明协议，无法确认与渠道插件兼容" };
    const target = typeof targetProtocol === "string" ? targetProtocol.trim() : "";
    if (!target) return { applied: false, reason: `渠道未选定已安装插件，无法应用 ${protocol} 的能力` };
    if (protocol !== target) return { applied: false, reason: `协议不匹配（目录 ${protocol} ≠ 渠道 ${target}）` };
    return { applied: true, kind, config: item.capabilityConfig };
}

function imageCapabilityConfigOf(value: unknown): ImageCapabilityConfig | null {
    const record = recordOf(value);
    if (!record) return null;
    const references = recordOf(record.references);
    if (!references) return null;
    const promptMaxChars = countOf(references.promptMaxChars);
    const maxImages = countOf(references.maxImages);
    const maxImageBytes = countOf(references.maxImageBytes);
    const maskSupported = boolOf(references.maskSupported);
    if (promptMaxChars === null || maxImages === null || maxImageBytes === null || maskSupported === null) return null;

    const size = recordOf(record.size);
    if (!size) return null;
    const parameter = textOf(size.parameter);
    const values = stringListOf(size.values);
    const defaultValue = trimmedStringOf(size.default);
    const allowCustom = boolOf(size.allowCustom);
    if (!parameter || !IMAGE_PARAMETERS.includes(parameter as ImageCapabilityConfig["size"]["parameter"])) return null;
    if (!values || defaultValue === null || allowCustom === null) return null;
    // 生产映射（Python ``ImageCapabilityConfig``）没有 resolution / transparentBackground /
    // responseFormat / outputFormat 之外的必填字段：这些字段缺失时保持缺失，由宿主 legacy
    // 读路径（normalizeModelCapabilityConfig / normalizeLegacyImageResolutionConfig）投影，
    // 不在这里补默认档位冒充能力。
    const resolution = optionalOf(record.resolution, toggleValuesOf);
    const quality = optionalOf(record.quality, toggleValuesOf);
    const transparentBackground = optionalOf(record.transparentBackground, toggleOf);
    const responseFormat = optionalOf(record.responseFormat, responseFormatOf);
    const outputFormat = optionalOf(record.outputFormat, supportedOf);
    const maxOutputs = positiveCountOf(record.maxOutputs, 100);
    if (resolution === null || quality === null || transparentBackground === null) return null;
    if (responseFormat === null || outputFormat === null || maxOutputs === null) return null;
    const image = {
        references: { promptMaxChars, maxImages, maxImageBytes, maskSupported },
        size: { parameter: parameter as ImageCapabilityConfig["size"]["parameter"], values, default: defaultValue, allowCustom },
        maxOutputs,
    } as ImageCapabilityConfig;
    if (resolution) image.resolution = resolution;
    if (quality) image.quality = quality;
    if (transparentBackground) image.transparentBackground = transparentBackground;
    if (responseFormat) image.responseFormat = responseFormat;
    if (outputFormat) image.outputFormat = outputFormat;
    if (size.presets !== undefined) {
        const presets = resolutionPresetsOf(size.presets);
        if (!presets) return null;
        // 空列表 = 网关没给出像素预设（宿主 ImageSizeConfig 缺省值就是 []），不是「禁止任何档位」；
        // 保留空数组会让尺寸选择器无项可选，所以按未声明处理，让读路径用默认预设。
        if (presets.length) image.size.presets = presets;
    }
    if (size.defaultTier !== undefined) {
        const defaultTier = textOf(size.defaultTier);
        if (!defaultTier) return null;
        image.size.defaultTier = defaultTier;
    }
    if (record.resolutionUsesQuality !== undefined) {
        const resolutionUsesQuality = boolOf(record.resolutionUsesQuality);
        if (resolutionUsesQuality === null) return null;
        image.resolutionUsesQuality = resolutionUsesQuality;
    }
    if (record.parameters !== undefined) {
        const parameters = imageParametersOf(record.parameters);
        if (!parameters) return null;
        image.parameters = parameters;
    }
    return image;
}

function videoCapabilityConfigOf(value: unknown): VideoCapabilityConfig | null {
    const record = recordOf(value);
    if (!record) return null;
    const references = recordOf(record.references);
    if (!references) return null;
    const referenceKeys = [
        "promptMaxChars",
        "minImages",
        "maxImages",
        "maxImageBytes",
        "maxVideos",
        "maxVideoBytes",
        "maxVideoDurationSeconds",
        "maxAudios",
        "maxAudioBytes",
        "maxAudioDurationSeconds",
    ] as const;
    const normalizedReferences = {} as VideoCapabilityConfig["references"];
    for (const key of referenceKeys) {
        const count = countOf(references[key]);
        if (count === null) return null;
        normalizedReferences[key] = count;
    }
    const duration = videoDurationOf(record.duration);
    const ratios = stringListOf(record.ratios);
    const defaultRatio = trimmedStringOf(record.defaultRatio);
    const resolutions = stringListOf(record.resolutions);
    const defaultResolution = trimmedStringOf(record.defaultResolution);
    const generateAudio = toggleOf(record.generateAudio);
    const watermark = toggleOf(record.watermark);
    const operations = stringListOf(record.operations, MAX_VALUES, false);
    const defaultOperation = textOf(record.defaultOperation);
    if (!duration || !ratios || defaultRatio === null || !resolutions || defaultResolution === null) return null;
    if (!generateAudio || !watermark || !operations || !defaultOperation) return null;
    if (operations.some((operation) => !VIDEO_OPERATIONS.includes(operation))) return null;
    if (!operations.includes(defaultOperation)) return null;
    if (!withinValues(defaultRatio, ratios) || !withinValues(defaultResolution, resolutions)) return null;
    const video: VideoCapabilityConfig = {
        references: normalizedReferences,
        duration,
        ratios,
        defaultRatio,
        resolutions,
        defaultResolution,
        generateAudio,
        watermark,
        operations,
        defaultOperation,
    };
    if (record.durationSupported !== undefined) {
        const durationSupported = boolOf(record.durationSupported);
        if (durationSupported === null) return null;
        video.durationSupported = durationSupported;
    }
    if (record.fixedScreenSpec !== undefined) {
        const fixedScreenSpec = screenSpecOf(record.fixedScreenSpec);
        if (!fixedScreenSpec) return null;
        video.fixedScreenSpec = fixedScreenSpec;
    }
    if (record.processing !== undefined) {
        const processing = processingOf(record.processing);
        if (!processing) return null;
        video.processing = processing;
    }
    return video;
}

function videoDurationOf(value: unknown): VideoCapabilityConfig["duration"] | null {
    const record = recordOf(value);
    if (!record) return null;
    const selection = typeof record.selection === "string" ? record.selection.trim() : "";
    const defaultValue = numberIn(record.default, 0.01, MAX_NUMBER);
    if (defaultValue === null) return null;
    if (selection === "range") {
        const min = numberIn(record.min, 0.01, MAX_NUMBER);
        const max = numberIn(record.max, 0.01, MAX_NUMBER);
        if (min === null || max === null || min > max || defaultValue < min || defaultValue > max) return null;
        if (record.step === undefined) return { selection, min, max, default: defaultValue };
        const step = numberIn(record.step, 0.001, MAX_NUMBER);
        return step === null ? null : { selection, min, max, step, default: defaultValue };
    }
    if (selection !== "enum") return null;
    const values = numberListOf(record.values, 0.01);
    if (!values?.length || !values.includes(defaultValue)) return null;
    return { selection, values, default: defaultValue };
}

function screenSpecOf(value: unknown): VideoCapabilityConfig["fixedScreenSpec"] | null {
    const record = recordOf(value);
    if (!record) return null;
    const ratios = stringListOf(record.ratios);
    const defaultRatio = trimmedStringOf(record.defaultRatio);
    const resolutions = stringListOf(record.resolutions);
    const defaultResolution = trimmedStringOf(record.defaultResolution);
    if (!ratios || defaultRatio === null || !resolutions || defaultResolution === null) return null;
    if (!withinValues(defaultRatio, ratios) || !withinValues(defaultResolution, resolutions)) return null;
    return { ratios, defaultRatio, resolutions, defaultResolution };
}

function processingOf(value: unknown): VideoProcessingConfig | null {
    const record = recordOf(value);
    if (!record) return null;
    const fpsPolicy = textOf(record.fpsPolicy);
    if (!fpsPolicy || !VIDEO_FPS_POLICIES.includes(fpsPolicy as VideoProcessingConfig["fpsPolicy"])) return null;
    const processing: VideoProcessingConfig = { fpsPolicy: fpsPolicy as VideoProcessingConfig["fpsPolicy"] };
    if (record.fpsOptions !== undefined) {
        const fpsOptions = numberListOf(record.fpsOptions, 0.01);
        if (!fpsOptions) return null;
        processing.fpsOptions = fpsOptions;
    }
    if (record.maxSourceSeconds !== undefined) {
        const maxSourceSeconds = numberIn(record.maxSourceSeconds, 0.01, MAX_NUMBER);
        if (maxSourceSeconds === null) return null;
        processing.maxSourceSeconds = maxSourceSeconds;
    }
    return processing;
}

function toggleValuesOf(value: unknown): ImageCapabilityConfig["resolution"] | null {
    const record = recordOf(value);
    if (!record) return null;
    const supported = boolOf(record.supported);
    const values = stringListOf(record.values);
    const defaultValue = trimmedStringOf(record.default);
    if (supported === null || !values || defaultValue === null) return null;
    // 声明“支持”却不给任何可选项，等于没有声明能力，不能当成能力写进渠道。
    if (supported && !values.length) return null;
    return { supported, values, default: defaultValue };
}

function toggleOf(value: unknown): { supported: boolean; default: boolean } | null {
    const record = recordOf(value);
    if (!record) return null;
    const supported = boolOf(record.supported);
    const defaultValue = boolOf(record.default);
    return supported === null || defaultValue === null ? null : { supported, default: defaultValue };
}

/** outputFormat 只声明"是否发送 output_format"，没有默认值字段。 */
function supportedOf(value: unknown): ImageCapabilityConfig["outputFormat"] | null {
    const record = recordOf(value);
    if (!record) return null;
    const supported = boolOf(record.supported);
    return supported === null ? null : { supported };
}

function responseFormatOf(value: unknown): ImageCapabilityConfig["responseFormat"] | null {
    const record = recordOf(value);
    if (!record) return null;
    const supported = boolOf(record.supported);
    if (supported === null) return null;
    if (record.default === undefined) return { supported };
    const format = textOf(record.default);
    if (!format || !IMAGE_RESPONSE_FORMATS.includes(format as ImageResponseFormat)) return null;
    return { supported, default: format as ImageResponseFormat };
}

function resolutionPresetsOf(value: unknown): NonNullable<ImageCapabilityConfig["size"]["presets"]> | null {
    if (!Array.isArray(value) || value.length > MAX_PRESETS) return null;
    const presets: NonNullable<ImageCapabilityConfig["size"]["presets"]> = [];
    for (const raw of value) {
        const record = recordOf(raw);
        if (!record) return null;
        const size = textOf(record.size);
        const tier = textOf(record.tier);
        const ratio = trimmedStringOf(record.ratio);
        const width = positiveCountOf(record.width, MAX_NUMBER);
        const height = positiveCountOf(record.height, MAX_NUMBER);
        if (!size || !tier || ratio === null || width === null || height === null) return null;
        presets.push({ size, tier, ratio, width, height });
    }
    return presets;
}

function imageParametersOf(value: unknown): ImageParameter[] | null {
    if (!Array.isArray(value) || value.length > MAX_PARAMETERS) return null;
    const parameters: ImageParameter[] = [];
    for (const raw of value) {
        const parameter = imageParameterOf(raw);
        if (!parameter) return null;
        parameters.push(parameter);
    }
    return parameters;
}

function imageParameterOf(value: unknown): ImageParameter | null {
    const record = recordOf(value);
    if (!record) return null;
    const name = textOf(record.name, 64);
    const label = textOf(record.label);
    const type = textOf(record.type);
    if (!name || !label || !type || !IMAGE_PARAMETER_TYPES.includes(type as ImageParameter["type"])) return null;
    const parameter: ImageParameter = { name, label, type: type as ImageParameter["type"] };
    if (record.description !== undefined) {
        const description = typeof record.description === "string" ? record.description.trim() : "";
        if (!description || description.length > MAX_DESCRIPTION_LENGTH) return null;
        parameter.description = description;
    }
    if (record.values !== undefined) {
        const values = parameterValuesOf(record.values, parameter.type);
        if (!values) return null;
        parameter.values = values;
    }
    for (const key of ["min", "max", "step", "maxLength"] as const) {
        if (record[key] === undefined) continue;
        const parsed = numberIn(record[key], 0, MAX_NUMBER);
        if (parsed === null) return null;
        parameter[key] = parsed;
    }
    if (record.default !== undefined) {
        if (!isParameterValue(record.default) || !matchesParameterType(record.default, parameter.type)) return null;
        parameter.default = record.default;
    }
    for (const key of ["required", "pricing", "enabled"] as const) {
        if (record[key] === undefined) continue;
        const parsed = boolOf(record[key]);
        if (parsed === null) return null;
        parameter[key] = parsed;
    }
    if (record.binding !== undefined) {
        const binding = textOf(record.binding);
        if (!binding) return null;
        parameter.binding = binding;
    }
    if (record.encoding !== undefined) {
        const encoding = textOf(record.encoding);
        if (!encoding || !IMAGE_PARAMETER_ENCODINGS.includes(encoding as NonNullable<ImageParameter["encoding"]>)) return null;
        parameter.encoding = encoding as NonNullable<ImageParameter["encoding"]>;
    }
    if (record.models !== undefined) {
        const models = stringListOf(record.models);
        if (!models) return null;
        parameter.models = models;
    }
    return parameter;
}

function parameterValuesOf(value: unknown, type: ImageParameter["type"]): ImageParameterValue[] | null {
    if (!Array.isArray(value) || value.length > MAX_VALUES) return null;
    const values: ImageParameterValue[] = [];
    for (const raw of value) {
        if (!isParameterValue(raw) || !matchesParameterType(raw, type)) return null;
        if (!values.includes(raw)) values.push(raw);
    }
    return values;
}

function isParameterValue(value: unknown): value is ImageParameterValue {
    return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function matchesParameterType(value: ImageParameterValue, type: ImageParameter["type"]) {
    if (type === "string") return typeof value === "string";
    if (type === "boolean") return typeof value === "boolean";
    if (type === "integer") return typeof value === "number" && Number.isInteger(value);
    return typeof value === "number";
}

function withinValues(defaultValue: string, values: readonly string[]) {
    if (!values.length || !defaultValue) return true;
    const normalized = defaultValue.toLowerCase();
    return values.some((value) => value.toLowerCase() === normalized);
}

/**
 * 可选字段的收窄：字段不存在 → 保持缺失（返回 undefined）；字段存在但损坏 → null（整份拒绝）。
 * 这样「网关没声明」不会被伪装成「网关声明了默认值」，也不会把损坏的嵌套结构当成能力。
 */
function optionalOf<T>(value: unknown, parse: (input: unknown) => T | null): T | undefined | null {
    return value === undefined ? undefined : parse(value);
}

function isOversized(value: unknown) {
    try {
        return JSON.stringify(value)?.length > MAX_CAPABILITY_JSON;
    } catch {
        return true;
    }
}

function recordOf(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown, maxLength = MAX_TEXT_LENGTH) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text && text.length <= maxLength ? text : null;
}

/** 允许空字符串的字符串字段（比例/清晰度的默认值可以为空，表示不预设）。 */
function trimmedStringOf(value: unknown) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text.length <= MAX_TEXT_LENGTH ? text : null;
}

function boolOf(value: unknown) {
    return typeof value === "boolean" ? value : null;
}

function numberIn(value: unknown, min: number, max: number) {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function countOf(value: unknown) {
    const parsed = numberIn(value, 0, MAX_NUMBER);
    return parsed === null || !Number.isInteger(parsed) ? null : parsed;
}

function positiveCountOf(value: unknown, max: number) {
    const parsed = numberIn(value, 1, max);
    return parsed === null || !Number.isInteger(parsed) ? null : parsed;
}

function stringListOf(value: unknown, maxItems = MAX_VALUES, allowEmpty = true): string[] | null {
    if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && !value.length)) return null;
    const list: string[] = [];
    const seen = new Set<string>();
    for (const raw of value) {
        const text = textOf(raw);
        if (!text) return null;
        if (seen.has(text)) continue;
        seen.add(text);
        list.push(text);
    }
    return list;
}

function numberListOf(value: unknown, min: number, maxItems = MAX_VALUES): number[] | null {
    if (!Array.isArray(value) || value.length > maxItems) return null;
    const list: number[] = [];
    for (const raw of value) {
        const parsed = numberIn(raw, min, MAX_NUMBER);
        if (parsed === null) return null;
        if (!list.includes(parsed)) list.push(parsed);
    }
    return list;
}
