import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { VideoCapabilityConfig } from "../src/lib/model-capabilities";
import { videoDurationRequestFields } from "../src/lib/video-duration-fields";
import { WorkbenchDurationChips } from "../src/pages/workbench/workbench-parameter-chips";

function baseProfile(overrides: Record<string, unknown>): VideoCapabilityConfig {
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
        duration: { selection: "range", min: 1, max: 1, step: 1, default: 1 },
        ratios: ["16:9"],
        defaultRatio: "16:9",
        resolutions: ["720p"],
        defaultResolution: "720p",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["image_to_video"],
        defaultOperation: "image_to_video",
        ...overrides,
    } as unknown as VideoCapabilityConfig;
}

// 动作控制类模型：能力清单里只有不生效的 1 秒占位 duration，durationSupported=false。
const motionControl = baseProfile({ durationSupported: false });
const seedance = baseProfile({ durationSupported: true, duration: { selection: "enum", values: [3, 5, 8], default: 5 } });

describe("工作台视频时长 chips 只对支持时长参数的模型渲染", () => {
    test("durationSupported=false 时不渲染时长控件，1 秒占位不可点", () => {
        const markup = renderToStaticMarkup(<WorkbenchDurationChips profile={motionControl} value="1" onChange={() => {}} />);
        expect(markup).toBe("");
        expect(markup).not.toContain("视频时长");
        expect(markup).not.toContain("radio");
    });

    test("支持的模型按能力选项渲染 chips 并选中当前秒数", () => {
        const markup = renderToStaticMarkup(<WorkbenchDurationChips profile={seedance} value="8" onChange={() => {}} />);
        expect(markup).toContain("视频时长");
        expect(markup).toContain("3 秒");
        expect(markup).toContain("5 秒");
        expect(markup).toContain("8 秒");
        expect(markup).toContain('role="radiogroup"');
        expect(markup).toContain('aria-checked="true"');
        expect(markup.indexOf('aria-checked="true"')).toBeGreaterThan(markup.indexOf("8 秒") - 400);
    });

    test("切回普通模型后时长控件重新出现", () => {
        expect(renderToStaticMarkup(<WorkbenchDurationChips profile={motionControl} value="5" onChange={() => {}} />)).toBe("");
        expect(renderToStaticMarkup(<WorkbenchDurationChips profile={seedance} value="5" onChange={() => {}} />)).toContain("5 秒");
    });
});

describe("工作台报价请求时长字段与提交保持一致", () => {
    test("不支持时长参数的模型报价里不带秒数", () => {
        const fields = videoDurationRequestFields(motionControl, "1");
        expect(fields.requirementSeconds).toBeUndefined();
        expect(fields.optionSeconds).toBeUndefined();
        expect(JSON.stringify(fields)).not.toContain("videoSeconds");
    });

    test("支持时长参数的模型报价照旧带秒数", () => {
        const fields = videoDurationRequestFields(seedance, "5");
        expect(fields.requirementSeconds).toBe("5");
        expect(fields.optionSeconds).toBe(5);
    });

    test("没有能力档案（undefined）的模型沿用旧行为，不剥离秒数", () => {
        expect(videoDurationRequestFields(undefined, "6")).toMatchObject({ requirementSeconds: "6", optionSeconds: 6 });
    });
});
