import { Select } from "@/components/ui/base/select";
import { videoDurationOptions, videoDurationSupported, type VideoCapabilityConfig } from "@/lib/model-capabilities";

export function ParameterChips({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
    if (options.length > 7) {
        return (
            <label className="workbench-setting-row">
                <span>{label}</span>
                <Select aria-label={label} value={value} onChange={onChange} options={options} />
            </label>
        );
    }
    return (
        <div className="workbench-chip-field">
            <span>{label}</span>
            <div role="radiogroup" aria-label={label}>
                {options.map((option) => (
                    <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className={value === option.value ? "is-active" : ""} onClick={() => onChange(option.value)}>
                        {option.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

/**
 * 视频时长 chips：durationSupported=false 的模型（例如固定时长的动作控制）没有时长参数，
 * 整块不渲染，避免把能力里那个不生效的 1 秒占位暴露成可点、可持久化的偏好。
 */
export function WorkbenchDurationChips({ profile, value, onChange }: { profile?: VideoCapabilityConfig | null; value: string; onChange: (value: string) => void }) {
    if (!profile || !videoDurationSupported(profile)) return null;
    const options = videoDurationOptions(profile).map((seconds) => ({ value: String(seconds), label: `${seconds} 秒` }));
    if (!options.length) return null;
    return <ParameterChips label="视频时长" value={value} options={options} onChange={onChange} />;
}
