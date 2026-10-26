import { readFileAsDataUrl } from "@/lib/image-utils";
import { imageParameterRequest } from "@/lib/image-parameters";
import { modelCapabilityConfigFor, videoResolutionRequest } from "@/lib/model-capabilities";
import { isResourceUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { getMediaBlob } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName, resolveModelChannel } from "@/stores/use-config-store";
import type { BackendGenerationTaskOptions } from "@/services/api/generation-task";
import type { BrowserPluginRequest, BrowserPluginReference } from "@/services/api/browser-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceVideo, ReferenceAudio } from "@/types/media";

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
    const declared = (value: unknown, fallback: string | undefined) => value ? String(value) : fallback;
    const resolution = mode === "image" ? declared(parameters?.imageResolution, config.imageResolution) : profile.video ? videoResolutionRequest(profile.video, config.vquality) || config.vquality : config.vquality;
    const output = {
        count: Number(config.count) || 1, duration: Number(config.videoSeconds) || 0,
        aspectRatio: parameterSize ? String(parameterSize) : config.size, resolution, quality: declared(parameters?.quality, config.quality),
        generateAudio: config.videoGenerateAudio === "true", watermark: config.videoWatermark === "true",
    };
    const channel = resolveModelChannel(config, config.model);
    const protocol = channel.modelCosts?.find((item) => item.model === modelOptionName(config.model))?.protocol || channel.interfaceType || "";
    const defaults = channel.modelCosts?.find((item) => item.model === modelOptionName(config.model))?.defaultOptions;
    const providerOptions = parameters ? undefined : { ...(metadata.providerOptions as Record<string, Record<string, unknown>> | undefined) };
    if (providerOptions && defaults) providerOptions[protocol] = { ...defaults, ...providerOptions[protocol] };
    return {
        capability: mode, model: modelOptionName(config.model), prompt: options.prompt, instructions: config.systemPrompt,
        images, videos, audios, inputs: [...images, ...videos, ...audios],
        ...output, imageCount: output.count, output,
        operation: String(metadata.videoEditOperation || metadata.videoOperation || ""),
        ...(parameters ? { imageParameters } : { providerOptions }),
        extra: { videoSeconds: config.videoSeconds, count: config.count },
    };
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
