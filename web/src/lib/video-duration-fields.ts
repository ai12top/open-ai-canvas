import { videoDurationSupported, type VideoCapabilityConfig } from "./model-capabilities";

/**
 * 报价请求里的时长字段：durationSupported=false 的模型整段省略时长键。
 * 报价与提交必须来自同一份判定，否则隐藏掉时长旋钮后报价会把时长又合回请求。
 */
export function videoDurationRequestFields(profile: VideoCapabilityConfig | undefined, seconds: string) {
    const supported = videoDurationSupported(profile);
    const numeric = Number(seconds);
    return {
        supported,
        requirementSeconds: supported && seconds ? seconds : undefined,
        optionSeconds: supported && Number.isFinite(numeric) ? numeric : undefined,
    };
}
