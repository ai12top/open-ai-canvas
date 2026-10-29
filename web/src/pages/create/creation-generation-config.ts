import { modelCapabilityConfigFor, normalizeVideoValue } from "@/lib/model-capabilities";
import { resolveModelVideoBooleanOptions } from "@/lib/model-selection";
import type { AiConfig } from "@/stores/use-config-store";
import type { CreationSettings } from "./creation-types";

// 创作台没有音频和水印开关；报价与提交共用所选模型的默认值和能力限制。
export function creationVideoConfig(config: AiConfig, model: string, settings: Pick<CreationSettings, "ratio" | "seconds" | "videoQuality">): AiConfig {
    const profile = modelCapabilityConfigFor(config, model).video!;
    const normalized = normalizeVideoValue(profile, {
        ratio: settings.ratio,
        seconds: settings.seconds,
        resolution: settings.videoQuality,
    });
    const next: AiConfig = {
        ...config,
        model,
        videoModel: model,
        size: normalized.ratio,
        vquality: normalized.resolution.replace(/p$/i, ""),
        ...resolveModelVideoBooleanOptions(
            config,
            model,
            {},
            {
                videoGenerateAudio: config.videoGenerateAudio,
                videoWatermark: config.videoWatermark,
            },
        ),
    };
    // 模型没有时长参数时不能把全局默认的 videoSeconds 顺手带进请求，否则隐藏了时长旋钮也照样发秒数。
    if (normalized.seconds !== undefined) next.videoSeconds = normalized.seconds;
    else delete (next as Partial<AiConfig>).videoSeconds;
    return next;
}
