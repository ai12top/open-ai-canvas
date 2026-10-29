// 图片尺寸声明的纯规则：画布提交的比例（16:9）与上游要求的像素尺寸（1536x864）之间的
// 唯一换算来源。app 的能力画像执行路径与浏览器插件的 WASM 适配器都只调用这里的函数，
// 任何一侧都不再自带一套像素规则。
//
// 这些规则原本只存在于 internal/app（resolveImageTaskSize / imageSizePixelOutbound 等），
// 迁移到这里后 app 侧保留同名薄包装，行为与错误文案完全不变。

package protocol

import (
	"fmt"
	"strconv"
	"strings"
)

// ImageSizePreset 是一个“档位 + 比例 → 像素尺寸”的换算项。
type ImageSizePreset struct {
	Tier   string `json:"tier"`
	Ratio  string `json:"ratio"`
	Size   string `json:"size"`
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
}

// ImageTierDeclaration 是分辨率/质量档位声明的最小投影。
type ImageTierDeclaration struct {
	Supported bool     `json:"supported"`
	Values    []string `json:"values,omitempty"`
	Default   string   `json:"default,omitempty"`
}

// ImageSizeDeclaration 是能力画像里与图片尺寸相关的纯数据投影。它只描述声明，不含任何
// 运行时状态，因此可以直接从清单（插件）或渠道模型（app）构造，也可以作为 JSON 传给 WASM。
//
// Encoding 与 UsesParameters 共同决定出网形状：parameters 路径下启用的 size 参数声明
// encoding=pixels 时上游只收像素；历史线路由 Parameter 与 InterfaceType 判定。
type ImageSizeDeclaration struct {
	Parameter                  string               `json:"parameter,omitempty"`
	Encoding                   string               `json:"encoding,omitempty"`
	UsesParameters             bool                 `json:"usesParameters,omitempty"`
	Values                     []string             `json:"values,omitempty"`
	Default                    string               `json:"default,omitempty"`
	AllowCustom                bool                 `json:"allowCustom,omitempty"`
	DefaultTier                string               `json:"defaultTier,omitempty"`
	ResolutionParameterDefault *string              `json:"resolutionParameterDefault,omitempty"`
	Presets                    []ImageSizePreset    `json:"presets,omitempty"`
	Resolution                 ImageTierDeclaration `json:"resolution"`
	Quality                    ImageTierDeclaration `json:"quality"`
	ResolutionUsesQuality      bool                 `json:"resolutionUsesQuality,omitempty"`
	// InterfaceType 只供历史线路（Parameters 未声明）判断出网形状。
	InterfaceType string `json:"interfaceType,omitempty"`
}

// PixelOutbound 表示该线路出网需要像素尺寸，决定“比例 → 像素”换算是否发生。
// parameter=size 由字段本身要求像素；aspect_ratio 只在声明式 OpenAI Images 上被翻成像素。
func (d ImageSizeDeclaration) PixelOutbound() bool {
	if d.UsesParameters {
		return strings.TrimSpace(d.Encoding) == "pixels"
	}
	if d.Parameter == "size" {
		return true
	}
	return d.Parameter == "aspect_ratio" && strings.TrimSpace(d.InterfaceType) == interfaceOpenAIImage
}

// interfaceOpenAIImage is the only legacy protocol whose aspect_ratio field is
// sent as WIDTHxHEIGHT.
const interfaceOpenAIImage = "openai-image"

// SingleTier 解析关闭独立分辨率后唯一的有效档位。多档位又没有默认档位时返回 false，
// 绝不按数组顺序猜档位。
func (d ImageSizeDeclaration) SingleTier() (string, bool) {
	if d.DefaultTier != "" {
		return d.DefaultTier, true
	}
	if d.ResolutionParameterDefault != nil {
		return *d.ResolutionParameterDefault, true
	}
	for _, preset := range d.Presets {
		if preset.Size == d.Default {
			return preset.Tier, true
		}
	}
	if len(d.Presets) == 0 {
		return "", true
	}
	tier := d.Presets[0].Tier
	for _, preset := range d.Presets {
		if preset.Tier != tier {
			return "", false
		}
	}
	return tier, true
}

// ActivePresets 允许执行期使用的换算表。独立分辨率开启（或历史线路）时使用全部预设；
// 关闭分辨率时只保留唯一档位的预设。
func (d ImageSizeDeclaration) ActivePresets() []ImageSizePreset {
	if !d.UsesParameters || d.Resolution.Supported {
		return d.Presets
	}
	tier, ok := d.SingleTier()
	if !ok {
		return nil
	}
	result := make([]ImageSizePreset, 0, len(d.Presets))
	for _, preset := range d.Presets {
		if preset.Tier == tier {
			result = append(result, preset)
		}
	}
	return result
}

// SelectionTier 把请求里的分辨率/质量取值解析成预设档位。parameters 路径只认声明的
// imageResolution 值；历史线路才接受 1k/2k/4k 与 low/medium/high 等别名。
func (d ImageSizeDeclaration) SelectionTier(value string) string {
	if d.UsesParameters {
		if d.Resolution.Supported && containsImageString(d.Resolution.Values, value) {
			return value
		}
		if !d.Resolution.Supported {
			if tier, ok := d.SingleTier(); ok {
				return tier
			}
		}
		return ""
	}
	if tier := DeclaredImageResolutionTier(value); tier != "" {
		return tier
	}
	if d.Resolution.Supported || (d.Quality.Supported && d.ResolutionUsesQuality) {
		return ImageResolutionTier(value)
	}
	for _, quality := range d.Quality.Values {
		if DeclaredImageResolutionTier(quality) != "" {
			return ImageResolutionTier(value)
		}
	}
	return ""
}

// DefaultTierValue 是缺省质量/分辨率对应的档位，作为预设查找的兜底。
func (d ImageSizeDeclaration) DefaultTierValue() string {
	if d.Resolution.Supported {
		return d.SelectionTier(d.Resolution.Default)
	}
	return d.SelectionTier(d.Quality.Default)
}

// Resolve 把画布按比例保存的 size（如 16:9）换算成上游声明要求的形态：
// 像素出网得到 preset.Size，比例出网得到 preset.Ratio，未命中时原样返回交由校验报错。
func (d ImageSizeDeclaration) Resolve(size string, quality string) string {
	value := strings.TrimSpace(size)
	if value == "" || strings.EqualFold(value, "auto") {
		return size
	}
	presets := d.ActivePresets()
	index := ImageSizePresetIndex(presets, value, d.SelectionTier(quality), d.DefaultTierValue())
	if index < 0 {
		return size
	}
	if d.PixelOutbound() {
		return presets[index].Size
	}
	if d.Parameter == "aspect_ratio" {
		return strings.TrimSpace(presets[index].Ratio)
	}
	return size
}

// RatioForSize 把已声明的 preset 像素值还原成它对应的比例。只认当前档位的 preset，
// 避免用低档价格取到高档像素。
func (d ImageSizeDeclaration) RatioForSize(size string, quality string) string {
	value := strings.TrimSpace(size)
	if value == "" || !strings.ContainsAny(value, "xX") {
		return ""
	}
	index := ImageSizePresetIndex(d.Presets, value, d.SelectionTier(quality), d.DefaultTierValue())
	if index < 0 {
		return ""
	}
	return strings.TrimSpace(d.Presets[index].Ratio)
}

// ImageSizePresetIndex 在换算表里查找与取值匹配的项。比例按归一化后比较，像素值按
// 大小写不敏感比较；tier 为空时退到 fallbackTier，两者都为空则不限档位。
func ImageSizePresetIndex(presets []ImageSizePreset, value string, tier string, fallbackTier string) int {
	value = strings.TrimSpace(value)
	if value == "" || strings.EqualFold(value, "auto") {
		return -1
	}
	tier = strings.TrimSpace(tier)
	if tier == "" {
		tier = strings.TrimSpace(fallbackTier)
	}
	ratio := ""
	if strings.Contains(value, ":") {
		ratio = NormalizeDeclaredImageRatio(value)
	}
	for index, preset := range presets {
		if tier != "" && !strings.EqualFold(strings.TrimSpace(preset.Tier), tier) {
			continue
		}
		if (ratio != "" && NormalizeDeclaredImageRatio(preset.Ratio) == ratio) || strings.EqualFold(strings.TrimSpace(preset.Size), value) {
			return index
		}
	}
	return -1
}

// NormalizeImageAspectRatio 把 WIDTHxHEIGHT 归一成最简比例；已是比例时原样返回小写值。
func NormalizeImageAspectRatio(value string) string {
	value = strings.TrimSpace(strings.ToLower(strings.ReplaceAll(value, "×", "x")))
	if strings.Contains(value, ":") {
		return value
	}
	parts := strings.Split(value, "x")
	if len(parts) != 2 {
		return ""
	}
	width, widthErr := strconv.Atoi(parts[0])
	height, heightErr := strconv.Atoi(parts[1])
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 {
		return ""
	}
	divisor := imageDimensionGCD(width, height)
	return strconv.Itoa(width/divisor) + ":" + strconv.Itoa(height/divisor)
}

// NormalizeDeclaredImageRatio 在比例归一化之上再约分数值比例（32:18 → 16:9）。
func NormalizeDeclaredImageRatio(value string) string {
	ratio := NormalizeImageAspectRatio(value)
	left, right, found := strings.Cut(ratio, ":")
	if !found {
		return ratio
	}
	width, widthErr := strconv.Atoi(left)
	height, heightErr := strconv.Atoi(right)
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 {
		return ratio
	}
	divisor := imageDimensionGCD(width, height)
	return strconv.Itoa(width/divisor) + ":" + strconv.Itoa(height/divisor)
}

func imageDimensionGCD(left int, right int) int {
	for right != 0 {
		left, right = right, left%right
	}
	if left < 1 {
		return 1
	}
	return left
}

// ImageResolutionTier 把质量/分辨率别名映射成档位（medium → 2k）。
func ImageResolutionTier(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1k", "low":
		return "1k"
	case "1.5k":
		return "1.5k"
	case "2k", "medium":
		return "2k"
	case "4k", "high":
		return "4k"
	default:
		return ""
	}
}

// DeclaredImageResolutionTier 只认显式声明的档位文字，不展开别名。
func DeclaredImageResolutionTier(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1k", "1.5k", "2k", "4k":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return ""
	}
}

func containsImageString(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(target)) {
			return true
		}
	}
	return false
}

// NormalizeImageRequest 是出网前的图片尺寸规范化：把请求里的比例与档位投影成声明要求
// 的形态（像素或比例），并保持 aspectRatio / output.aspectRatio 一致。它只做投影，不校验
// 其他参数、不发起任何请求。
//
// 必须在上游适配器的 ApplyImageParameters 之前调用：后者会用 imageParameters 覆盖
// AspectRatio，晚于它执行会把换算结果丢掉。
func NormalizeImageRequest(request GenerationRequest, declaration ImageSizeDeclaration) (GenerationRequest, error) {
	if request.Capability != CapabilityImage {
		return request, nil
	}
	size := strings.TrimSpace(request.AspectRatio)
	if declared, ok := imageParameterText(request.ImageParameters, "size"); ok {
		size = declared
		request.AspectRatio = declared
	}
	quality := strings.TrimSpace(request.Resolution)
	if declared, ok := imageParameterText(request.ImageParameters, "imageResolution"); ok {
		quality = declared
		request.Resolution = declared
	}
	resolved := strings.TrimSpace(declaration.Resolve(size, quality))
	if resolved != "" {
		request.AspectRatio = resolved
		request.Output.AspectRatio = resolved
	}
	if !declaration.PixelOutbound() {
		return request, nil
	}
	if strings.Contains(request.AspectRatio, ":") {
		return request, fmt.Errorf("当前比例与分辨率缺少明确的像素尺寸映射")
	}
	// 自由像素参数必须把换算值带到适配器；比例枚举保留声明值由 aspectRatio 承接。
	if request.ImageParameters != nil && imageSizeValueAccepted(declaration.Values, request.AspectRatio) {
		request.ImageParameters["size"] = request.AspectRatio
	}
	return request, nil
}

func imageParameterText(values map[string]any, name string) (string, bool) {
	if values == nil {
		return "", false
	}
	raw, ok := values[name]
	if !ok || raw == nil {
		return "", false
	}
	text := strings.TrimSpace(fmt.Sprint(raw))
	if text == "" {
		return "", false
	}
	return text, true
}

func imageSizeValueAccepted(values []string, value string) bool {
	if len(values) == 0 {
		return true
	}
	return containsImageString(values, value)
}
