import { describe, expect, test } from "bun:test";
import { defaultModelCapabilityConfig, type VideoCapabilityConfig } from "../src/lib/model-capabilities";
import { shotDurationFields, shotDurationSourceMs, shotEditorDurationSeconds, shotGenerationSeconds, shotSavePayload, type ShotEditorValues } from "../src/pages/projects/detail/workflow-shot-payload";

// 固定时长的动作控制类模型：能力里带一个不生效的 1 秒占位 duration，durationSupported=false。
function motionControlProfile(): VideoCapabilityConfig {
    return {
        references: {
            promptMaxChars: 2000,
            minImages: 0,
            maxImages: 1,
            maxImageBytes: 10_000_000,
            maxVideos: 1,
            maxVideoBytes: 50_000_000,
            maxVideoDurationSeconds: 30,
            maxAudios: 0,
            maxAudioBytes: 0,
            maxAudioDurationSeconds: 0,
        },
        durationSupported: false,
        duration: { selection: "range", min: 1, max: 1, step: 1, default: 1 },
        ratios: ["16:9", "9:16"],
        defaultRatio: "16:9",
        resolutions: ["720p", "1080p"],
        defaultResolution: "720p",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["image_to_video"],
        defaultOperation: "image_to_video",
    } as unknown as VideoCapabilityConfig;
}

function normalProfile(): VideoCapabilityConfig {
    return defaultModelCapabilityConfig("volcengine-ark-video", "seedance-2-0").video!;
}

const shot = { id: "shot-1", unitId: "unit-1", position: 2, status: "ready", durationMs: 4000 };

function editorValues(overrides: Partial<ShotEditorValues> = {}): ShotEditorValues {
    return {
        title: "镜头 1",
        plotDescription: "角色推门进入",
        durationSeconds: 4,
        ...overrides,
    };
}

describe("镜头时长表单值与模型生成时长解耦（durationSupported=false）", () => {
    test("表单里保留镜头自己的剪辑时长，不再写入 NaN", () => {
        expect(shotEditorDurationSeconds(motionControlProfile(), 4000)).toBe(4);
        expect(shotEditorDurationSeconds(motionControlProfile(), 0)).toBe(0);
        expect(Number.isFinite(shotEditorDurationSeconds(motionControlProfile(), 4000))).toBe(true);
    });

    test("镜头时长 0 是合法值，不会被 3 秒默认值顶掉", () => {
        expect(shotDurationSourceMs(0, 4000)).toBe(0);
        expect(shotDurationSourceMs(undefined, 0)).toBe(0);
        expect(shotDurationSourceMs(undefined, undefined)).toBe(3000);
    });

    test("时长控件被隐藏导致表单缺键时，保存仍然沿用镜头原时长", () => {
        const payload = shotSavePayload(editorValues({ durationSeconds: undefined }), shot);
        expect(payload.durationMs).toBe(4000);
        expect(payload.revision.durationMs).toBe(4000);
        // 后端把 NaN 序列化成 null 后会存成 0，这里必须完全不出现在 payload 里。
        expect(JSON.parse(JSON.stringify(payload)).durationMs).toBe(4000);
        expect(JSON.parse(JSON.stringify(payload)).revision.durationMs).toBe(4000);
    });

    test("NaN 时长不会落进保存 payload", () => {
        const payload = shotSavePayload(editorValues({ durationSeconds: Number.NaN }), shot);
        expect(payload.durationMs).toBe(4000);
        expect(payload.revision.durationMs).toBe(4000);
        expect(Number.isFinite(payload.durationMs)).toBe(true);
    });

    test("镜头本身时长是 0 时保存后仍然是 0", () => {
        const payload = shotSavePayload(editorValues({ durationSeconds: undefined }), { ...shot, durationMs: 0 });
        expect(payload.durationMs).toBe(0);
        expect(payload.revision.durationMs).toBe(0);
    });

    test("模型支持时长参数时仍然更新镜头时长", () => {
        const profile = normalProfile();
        expect(shotEditorDurationSeconds(profile, 4000, "7")).toBe(7);
        const payload = shotSavePayload(editorValues({ durationSeconds: 7 }), shot);
        expect(payload.durationMs).toBe(7000);
        expect(payload.revision.durationMs).toBe(7000);
    });

    test("保存 payload 保留镜头其余字段", () => {
        const payload = shotSavePayload(editorValues({ dialogue: "我回来了", shotSize: "全景", durationSeconds: undefined }), shot);
        expect(payload.id).toBe("shot-1");
        expect(payload.unitId).toBe("unit-1");
        expect(payload.position).toBe(2);
        expect(payload.status).toBe("ready");
        expect(payload.title).toBe("镜头 1");
        expect(payload.description).toBe("角色推门进入");
        expect(payload.revision.dialogue).toBe("我回来了");
        expect(payload.revision.shotSize).toBe("全景");
    });
});

describe("报价与提交共享同一份时长判定", () => {
    test("durationSupported=false 时请求里整段省略时长键", () => {
        expect(shotDurationFields(false, "5")).toEqual({});
        expect(JSON.stringify(shotDurationFields(false, "5"))).not.toContain("videoSeconds");
    });

    test("支持时长时同时给出报价选项与提交秒数", () => {
        expect(shotDurationFields(true, "5")).toEqual({ videoSeconds: "5", optionSeconds: 5 });
    });

    test("生成请求的整秒时长跟随镜头保存后的时长", () => {
        expect(shotGenerationSeconds(4000)).toBe("4");
        expect(shotGenerationSeconds(0)).toBe("1");
        expect(shotGenerationSeconds(Number.NaN)).toBe("1");
    });
});
