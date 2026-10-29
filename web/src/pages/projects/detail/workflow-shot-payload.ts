import { normalizeVideoValue, videoDurationSupported, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import type { ProjectShot, ShotRevisionInput } from "@/services/api/projects";

export type ShotEditorValues = Omit<ShotRevisionInput, "durationMs"> & {
    title: string;
    durationSeconds?: number;
};

export type ShotSavePayload = {
    id: string;
    unitId?: string;
    title: string;
    description: string;
    position: number;
    durationMs: number;
    status: string;
    revision: ShotRevisionInput;
};

const DEFAULT_SHOT_DURATION_MS = 3000;

function isFiniteMs(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/** 镜头自身时长：修订版本优先，其次镜头记录，都缺时回落到 3 秒。0 是合法时长，不能用 `||` 兜底。 */
export function shotDurationSourceMs(revisionDurationMs: number | undefined, shotDurationMs: number | undefined): number {
    if (isFiniteMs(revisionDurationMs)) return revisionDurationMs;
    if (isFiniteMs(shotDurationMs)) return shotDurationMs;
    return DEFAULT_SHOT_DURATION_MS;
}

/**
 * 表单控件值 → 保存用的毫秒。时长控件在模型不支持时长参数时整块隐藏，
 * 键可能缺失或为 NaN，此时保留镜头原来的时长，绝不把 NaN 写进 payload。
 */
export function shotDurationMs(value: unknown, fallbackMs: number): number {
    return isFiniteMs(value) ? Math.round(value * 1000) : fallbackMs;
}

/**
 * 镜头剪辑时长和模型生成时长旋钮不是同一件事：模型支持时长参数时按模型约束归一化（沿用原逻辑），
 * 不支持（durationSupported=false）时不渲染该控件，表单里保留镜头自己的剪辑时长。
 */
export function shotEditorDurationSeconds(profile: VideoCapabilityConfig | undefined, sourceDurationMs: number, requestedSeconds?: string): number {
    const shotSeconds = (isFiniteMs(sourceDurationMs) ? sourceDurationMs : 0) / 1000;
    if (!profile || !videoDurationSupported(profile)) return shotSeconds;
    const normalized = normalizeVideoValue(profile, { seconds: requestedSeconds ?? String(Math.max(0.5, shotSeconds)) });
    const seconds = Number(normalized.seconds);
    return normalized.seconds !== undefined && Number.isFinite(seconds) ? seconds : Math.max(0.5, shotSeconds);
}

/** 镜头时长对应的生成秒数（生成请求只有整秒）。 */
export function shotGenerationSeconds(durationMs: number): string {
    return String(Math.max(1, Math.round((isFiniteMs(durationMs) ? durationMs : 0) / 1000)));
}

export type ShotDurationFields = { videoSeconds?: string; optionSeconds?: number };

/** 时长键只在模型真的支持时长参数时出现：报价与提交共用这一份判定，避免隐藏控件后时长又被合回请求。 */
export function shotDurationFields(durationSupported: boolean, generationSeconds: string): ShotDurationFields {
    if (!durationSupported) return {};
    const seconds = Number(generationSeconds);
    return Number.isFinite(seconds) ? { videoSeconds: generationSeconds, optionSeconds: seconds } : {};
}

export function shotRevisionInput(values: ShotEditorValues, durationMs: number): ShotRevisionInput {
    return {
        plotDescription: values.plotDescription,
        action: values.action,
        dialogue: values.dialogue,
        shotSize: values.shotSize,
        cameraAngle: values.cameraAngle,
        cameraMovement: values.cameraMovement,
        durationMs,
        imagePrompt: values.imagePrompt,
        videoPrompt: values.videoPrompt,
        negativePrompt: values.negativePrompt,
        continuityNotes: values.continuityNotes,
    };
}

export function shotSavePayload(values: ShotEditorValues, shot: Pick<ProjectShot, "id" | "unitId" | "position" | "status" | "durationMs">): ShotSavePayload {
    const durationMs = shotDurationMs(values.durationSeconds, isFiniteMs(shot.durationMs) ? shot.durationMs : DEFAULT_SHOT_DURATION_MS);
    return {
        id: shot.id,
        unitId: shot.unitId,
        title: values.title,
        description: values.plotDescription,
        position: shot.position,
        durationMs,
        status: shot.status,
        revision: shotRevisionInput(values, durationMs),
    };
}
