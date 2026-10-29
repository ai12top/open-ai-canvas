import { readFileAsDataUrl } from "@/lib/image-utils";
import { imageParameterRequest } from "@/lib/image-parameters";
import { modelCapabilityConfigFor, videoDurationSupported, videoResolutionRequest } from "@/lib/model-capabilities";
import { isResourceUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { callBrowserProtocol } from "@/services/api/browser-protocol";
import { getMediaBlob } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName, resolveModelChannel } from "@/stores/use-config-store";
import type { BackendGenerationTaskOptions } from "@/services/api/generation-task";
import type { BrowserPluginRequest, BrowserPluginReference } from "@/services/api/browser-plugin";
import type { ImageSizeDeclaration } from "@/services/api/browser-protocol";
import type { ImageCapabilityConfig } from "@/lib/model-capabilities";
import type { ImageResolutionOption } from "@/lib/image-resolution-tiers";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceVideo, ReferenceAudio } from "@/types/media";

/**
 * 画像 → 声明的纯投影（与 Go protocol.ImageSizeDeclaration 同形）。
 * 只搬运已声明的数据，像素/比例换算只发生在 Go 侧，前端不复制任何像素规则。
 */
export function imageSizeDeclaration(profile?: ImageCapabilityConfig, interfaceType?: string): ImageSizeDeclaration | undefined {
    if (!profile) return undefined;
    const sizeField = profile.parameters?.find((field) => field.name === "size" && field.enabled !== false);
    const resolutionField = profile.parameters?.find((field) => field.name === "imageResolution" && field.default != null && field.default !== "auto");
    return {
        parameter: profile.size.parameter,
        encoding: sizeField?.encoding,
        usesParameters: Boolean(profile.parameters),
        interfaceType,
        values: profile.size.values,
        default: profile.size.default,
        allowCustom: profile.size.allowCustom,
        defaultTier: profile.size.defaultTier,
        resolutionParameterDefault: resolutionField ? String(resolutionField.default) : undefined,
        presets: (profile.size.presets || []).map((preset: ImageResolutionOption) => ({ tier: preset.tier, ratio: preset.ratio, size: preset.size, width: preset.width, height: preset.height })),
        resolution: { supported: profile.resolution.supported, values: profile.resolution.values, default: profile.resolution.default },
        quality: { supported: profile.quality.supported, values: profile.quality.values, default: profile.quality.default },
        resolutionUsesQuality: profile.resolutionUsesQuality,
    };
}

// Project existing canvas intent onto protocol.GenerationRequest; all provider
// rules, defaults, validations and wire mappings still run in the original Go core.
export async function browserPluginRequest(options: BackendGenerationTaskOptions): Promise<BrowserPluginRequest> {
    const { config, mode, metadata = {} } = options;
    const images = await Promise.all((options.referenceImages || []).map((image, order) => reference(image, "image", order)));
    for (const [index, image] of images.entries()) {
        const original = options.referenceImages![index];
        image.role = mode === "image" ? "edit_source"
            : original.role === "first_frame" || original.role === "last_frame" ? original.role
            : metadata.videoEditOperation === "reference_to_video" ? "reference_image"
            : metadata.videoStartFrameNodeId === original.id ? "first_frame"
            : metadata.videoEndFrameNodeId === original.id ? "last_frame"
            : metadata.videoStartFrameNodeId || metadata.videoEndFrameNodeId ? "reference_image" : "";
    }
    if (options.mask) images.push({ ...await reference(options.mask, "image", images.length), role: "mask" });
    const videos = await Promise.all((options.referenceVideos || []).map((media, order) => reference(media, "video", order)));
    const audios = await Promise.all((options.referenceAudios || []).map((media, order) => reference(media, "audio", order)));
    const profile = modelCapabilityConfigFor(config, config.model);
    const parameters = mode === "image" && profile.image ? imageParameterRequest(profile.image, config, true) : undefined;
    const { size: parameterSize, ...imageParameters } = parameters || {};
    // 声明值（含 manifest 默认值）优先，和 Go 侧解析后的 request 保持一致。
    const declared = (value: unknown, fallback: string | undefined) => parameters ? value == null ? undefined : String(value) : fallback;
    const resolution = mode === "image" ? declared(parameters?.imageResolution, config.imageResolution) : profile.video ? videoResolutionRequest(profile.video, config.vquality) || config.vquality : config.vquality;
    const configuredCount = Number(parameters ? parameters.count ?? 1 : config.count);
    const count = Number.isFinite(configuredCount) && configuredCount >= 1 ? Math.floor(configuredCount) : 1;
    const durationSupported = mode === "video" ? videoDurationSupported(profile.video) : undefined;
    const duration = mode === "video" && durationSupported ? Number(config.videoSeconds) || 0 : undefined;
    const output = {
        count,
        ...(duration !== undefined ? { duration } : {}),
        aspectRatio: declared(parameterSize, config.size),
        resolution,
        quality: declared(parameters?.quality, config.quality),
        generateAudio: config.videoGenerateAudio === "true",
        watermark: config.videoWatermark === "true",
    };
    const channel = resolveModelChannel(config, config.model);
    const protocol = channel.modelCosts?.find((item) => item.model === modelOptionName(config.model))?.protocol || channel.interfaceType || "";
    const defaults = channel.modelCosts?.find((item) => item.model === modelOptionName(config.model))?.defaultOptions;
    const providerOptions = parameters ? undefined : { ...(metadata.providerOptions as Record<string, Record<string, unknown>> | undefined) };
    if (providerOptions && defaults) providerOptions[protocol] = { ...defaults, ...providerOptions[protocol] };
    // 渠道默认参数里可能带着时长键；模型不支持时长参数时只剥掉这些键，其余（图片等）参数原样保留。
    if (providerOptions && durationSupported === false) providerOptions[protocol] = withoutVideoDurationKeys(providerOptions[protocol]);
    const extra: Record<string, unknown> = { count: String(count) };
    if (mode !== "video" || durationSupported) {
        extra.videoSeconds = config.videoSeconds;
    }
    const request: BrowserPluginRequest = {
        capability: mode,
        model: modelOptionName(config.model),
        prompt: options.prompt,
        instructions: config.systemPrompt,
        images,
        videos,
        audios,
        inputs: [...images, ...videos, ...audios],
        ...output,
        ...(duration !== undefined ? { duration } : {}),
        imageCount: output.count,
        output,
        operation: String(metadata.videoEditOperation || metadata.videoOperation || ""),
        ...(parameters ? { imageParameters } : { providerOptions }),
        extra,
    };
    // 图片尺寸在 Go 侧规范化（与执行路径同一份规则），落盘/提交的都是已归一化的 request。
    const imageSize = mode === "image" ? imageSizeDeclaration(profile.image, protocol) : undefined;
    return imageSize ? normalizeImageRequest(request, imageSize) : request;
}

const VIDEO_DURATION_KEYS = ["videoSeconds", "duration", "seconds", "durationSeconds"] as const;

function withoutVideoDurationKeys(options: Record<string, unknown> | undefined): Record<string, unknown> {
    const next: Record<string, unknown> = { ...(options || {}) };
    for (const key of VIDEO_DURATION_KEYS) delete next[key];
    return next;
}

/** 桥上的 normalizeImage 是本地 WASM 调用（零 HTTP），不加载插件清单、不碰凭据。 */
async function normalizeImageRequest(request: BrowserPluginRequest, imageSize: ImageSizeDeclaration): Promise<BrowserPluginRequest> {
    return callBrowserProtocol<BrowserPluginRequest>({ op: "normalizeImage", manifest: {}, request, imageSize });
}

async function reference(media: ReferenceImage | ReferenceVideo | ReferenceAudio, kind: "image" | "video" | "audio", order: number): Promise<BrowserPluginReference> {
    const source = media.url || ("dataUrl" in media ? media.dataUrl : "");
    const result: BrowserPluginReference = {
        id: media.id, kind, role: kind === "video" ? "reference_video" : kind === "audio" ? "reference_audio" : "reference_image",
        name: media.name, mimeType: media.type, order,
        metadata: { bytes: media.bytes, width: "width" in media ? media.width : undefined, height: "height" in media ? media.height : undefined, durationMs: "durationMs" in media ? media.durationMs : undefined },
    };
    // Public references remain URLs; private canvas resources are read with the
    // existing storage helpers, never forwarded with a canvas session credential.
    if (/^https?:\/\//iu.test(source) && !isResourceUrl(source) && !resourceIdFromStorageKey(media.storageKey)) {
        return { ...result, url: source };
    }
    if (kind === "image") return { ...result, dataUrl: await imageToDataUrl(media) };
    if (source.startsWith("data:")) return { ...result, dataUrl: source };
    let blob = media.storageKey ? await getMediaBlob(media.storageKey) : null;
    if (!blob && source) {
        const response = await fetch(source, { credentials: isResourceUrl(source) ? "include" : "omit" });
        if (!response.ok) throw new Error("参考媒体读取失败，请重新选择素材");
        blob = await response.blob();
    }
    if (!blob) throw new Error("参考媒体尚未保存，请重新选择素材");
    return { ...result, dataUrl: await readFileAsDataUrl(blob) };
}
