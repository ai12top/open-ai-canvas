package protocol

import "testing"

// pixelEnumDeclaration 复现审查缺陷里的清单：size 是比例枚举但 encoding=pixels，
// 换算表里 16:9 的 1k 像素是 1536x864。
func pixelEnumDeclaration() ImageSizeDeclaration {
	return ImageSizeDeclaration{
		Parameter:      "aspect_ratio",
		Encoding:       "pixels",
		UsesParameters: true,
		Values:         []string{"16:9", "9:16"},
		Default:        "16:9",
		Presets: []ImageSizePreset{
			{Tier: "1k", Ratio: "16:9", Size: "1536x864", Width: 1536, Height: 864},
			{Tier: "1k", Ratio: "9:16", Size: "864x1536", Width: 864, Height: 1536},
			{Tier: "2k", Ratio: "16:9", Size: "2560x1440", Width: 2560, Height: 1440},
		},
		Resolution: ImageTierDeclaration{Supported: true, Values: []string{"1k", "2k"}, Default: "1k"},
	}
}

func imageRequest(size string, quality string) GenerationRequest {
	return GenerationRequest{
		Capability:      CapabilityImage,
		AspectRatio:     size,
		Resolution:      quality,
		Output:          OutputOptions{AspectRatio: size},
		ImageParameters: map[string]any{},
	}
}

func TestNormalizeImageRequestPixelsForRatioEnum(t *testing.T) {
	request, err := NormalizeImageRequest(imageRequest("16:9", "1k"), pixelEnumDeclaration())
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	if request.AspectRatio != "1536x864" {
		t.Fatalf("aspect ratio = %q, want 1536x864", request.AspectRatio)
	}
	if request.Output.AspectRatio != "1536x864" {
		t.Fatalf("output aspect ratio = %q, want 1536x864", request.Output.AspectRatio)
	}
	// 比例枚举不写回 size 参数：上游的 size 参数只接受声明的比例值。
	if _, ok := request.ImageParameters["size"]; ok {
		t.Fatalf("ratio enum must not backfill size parameter: %v", request.ImageParameters)
	}
}

func TestNormalizeImageRequestDeclaredValuesWin(t *testing.T) {
	request := imageRequest("9:16", "1k")
	request.ImageParameters = map[string]any{"size": "16:9", "imageResolution": "2k"}
	normalized, err := NormalizeImageRequest(request, pixelEnumDeclaration())
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	if normalized.Resolution != "2k" || normalized.AspectRatio != "2560x1440" {
		t.Fatalf("declared values ignored: resolution=%q size=%q", normalized.Resolution, normalized.AspectRatio)
	}
	if normalized.Output.AspectRatio != "2560x1440" {
		t.Fatalf("output aspect ratio = %q, want 2560x1440", normalized.Output.AspectRatio)
	}
}

func TestNormalizeImageRequestFreePixelsBackfill(t *testing.T) {
	declaration := pixelEnumDeclaration()
	declaration.Values = nil
	normalized, err := NormalizeImageRequest(imageRequest("16:9", "2k"), declaration)
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	if normalized.AspectRatio != "2560x1440" {
		t.Fatalf("aspect ratio = %q, want 2560x1440", normalized.AspectRatio)
	}
	// 自由像素参数需要在 imageParameters 里带上换算值，适配器才能写进上游字段。
	if normalized.ImageParameters["size"] != "2560x1440" {
		t.Fatalf("free pixel size = %v, want 2560x1440", normalized.ImageParameters["size"])
	}
}

func TestNormalizeImageRequestSurvivesApplyImageParameters(t *testing.T) {
	definitions := []ImageParameter{
		{Name: "size", Type: "string", Binding: "aspectRatio", Encoding: "pixels", Values: []any{"16:9", "9:16"}, Default: "16:9"},
		{Name: "imageResolution", Type: "string", Binding: "resolution", Values: []any{"1k", "2k"}, Default: "1k"},
	}
	request := imageRequest("16:9", "1k")
	request.ImageParameters = map[string]any{"imageResolution": "1k"}
	normalized, err := NormalizeImageRequest(request, pixelEnumDeclaration())
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	applied, err := ApplyImageParameters(normalized, definitions)
	if err != nil {
		t.Fatalf("apply failed: %v", err)
	}
	// 适配器阶段不得把规范化后的像素尺寸改回比例。
	if applied.AspectRatio != "1536x864" || applied.Output.AspectRatio != "1536x864" {
		t.Fatalf("apply undid normalization: %q / %q", applied.AspectRatio, applied.Output.AspectRatio)
	}

	// 自由像素参数在清单里没有 Values 约束，Apply 才会接受换算出的像素值。
	freeDefinitions := []ImageParameter{{Name: "size", Type: "string", Binding: "aspectRatio", Encoding: "pixels"}}
	free := pixelEnumDeclaration()
	free.Values = nil
	freeRequest := imageRequest("16:9", "2k")
	freeRequest.ImageParameters = map[string]any{}
	normalized, err = NormalizeImageRequest(freeRequest, free)
	if err != nil {
		t.Fatalf("free pixel normalize failed: %v", err)
	}
	applied, err = ApplyImageParameters(normalized, freeDefinitions)
	if err != nil {
		t.Fatalf("free pixel apply failed: %v", err)
	}
	if applied.AspectRatio != "2560x1440" {
		t.Fatalf("free pixel aspect ratio = %q, want 2560x1440", applied.AspectRatio)
	}
}

func TestNormalizeImageRequestUsesDisabledParameterDefault(t *testing.T) {
	declaration := pixelEnumDeclaration()
	declaration.Resolution.Supported = false
	defaultTier := "2k"
	declaration.ResolutionParameterDefault = &defaultTier
	normalized, err := NormalizeImageRequest(imageRequest("16:9", "auto"), declaration)
	if err != nil || normalized.AspectRatio != "2560x1440" {
		t.Fatalf("disabled parameter default lost: request=%#v error=%v", normalized, err)
	}
	declaration.DefaultTier = "1k"
	normalized, err = NormalizeImageRequest(imageRequest("16:9", "auto"), declaration)
	if err != nil || normalized.AspectRatio != "1536x864" {
		t.Fatalf("explicit size tier must take precedence: request=%#v error=%v", normalized, err)
	}
}

func TestNormalizeImageRequestMissingPixelMapping(t *testing.T) {
	_, err := NormalizeImageRequest(imageRequest("3:2", "1k"), pixelEnumDeclaration())
	if err == nil {
		t.Fatal("expected missing mapping error")
	}
	if err.Error() != "当前比例与分辨率缺少明确的像素尺寸映射" {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestNormalizeImageRequestRatioOutboundPassthrough(t *testing.T) {
	declaration := pixelEnumDeclaration()
	declaration.Encoding = "ratio"
	normalized, err := NormalizeImageRequest(imageRequest("3:2", "1k"), declaration)
	if err != nil {
		t.Fatalf("ratio outbound must not error: %v", err)
	}
	if normalized.AspectRatio != "3:2" || normalized.Output.AspectRatio != "3:2" {
		t.Fatalf("undeclared ratio changed: %q / %q", normalized.AspectRatio, normalized.Output.AspectRatio)
	}

	normalized, err = NormalizeImageRequest(imageRequest("16:9", "1k"), declaration)
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	if normalized.AspectRatio != "16:9" {
		t.Fatalf("ratio outbound size = %q, want 16:9", normalized.AspectRatio)
	}
}

func TestNormalizeImageRequestIgnoresOtherCapabilities(t *testing.T) {
	request := GenerationRequest{Capability: CapabilityVideo, AspectRatio: "16:9", Output: OutputOptions{AspectRatio: "16:9"}}
	normalized, err := NormalizeImageRequest(request, pixelEnumDeclaration())
	if err != nil || normalized.AspectRatio != "16:9" || normalized.Output.AspectRatio != "16:9" {
		t.Fatalf("video request touched: %v %q", err, normalized.AspectRatio)
	}
}

func TestImageSizeDeclarationResolve(t *testing.T) {
	declaration := pixelEnumDeclaration()
	cases := []struct {
		size    string
		quality string
		want    string
	}{
		{"16:9", "1k", "1536x864"},
		{"16:9", "", "1536x864"},
		{"16:9", "2k", "2560x1440"},
		{"1536x864", "1k", "1536x864"},
		{"", "1k", ""},
		{"auto", "1k", "auto"},
		{"2:1", "1k", "2:1"},
	}
	for _, test := range cases {
		if got := declaration.Resolve(test.size, test.quality); got != test.want {
			t.Fatalf("Resolve(%q,%q) = %q, want %q", test.size, test.quality, got, test.want)
		}
	}
}

func TestImageSizeDeclarationRatioForSize(t *testing.T) {
	declaration := pixelEnumDeclaration()
	if got := declaration.RatioForSize("1536x864", "1k"); got != "16:9" {
		t.Fatalf("ratio for 1k pixels = %q", got)
	}
	// 档位不匹配时不能用低档价格取到高档像素的换算。
	if got := declaration.RatioForSize("2560x1440", "1k"); got != "" {
		t.Fatalf("cross tier ratio = %q, want empty", got)
	}
	if got := declaration.RatioForSize("16:9", "1k"); got != "" {
		t.Fatalf("ratio input must not map: %q", got)
	}
}

func TestImageSizeDeclarationSingleTierAndPixelOutbound(t *testing.T) {
	declaration := pixelEnumDeclaration()
	declaration.Resolution = ImageTierDeclaration{Supported: false}
	// 多档位又没有默认档位时绝不按数组顺序猜档位。
	if tier, ok := declaration.SingleTier(); ok {
		t.Fatalf("ambiguous tiers must not resolve: %q", tier)
	}
	declaration.DefaultTier = "1k"
	if tier, ok := declaration.SingleTier(); !ok || tier != "1k" {
		t.Fatalf("single tier = %q %v", tier, ok)
	}
	active := declaration.ActivePresets()
	if len(active) != 2 {
		t.Fatalf("active presets = %d, want only the 1k tier", len(active))
	}
	if !declaration.PixelOutbound() {
		t.Fatal("parameters path with encoding=pixels must be pixel outbound")
	}
	legacy := ImageSizeDeclaration{Parameter: "aspect_ratio", InterfaceType: "openai-image"}
	if !legacy.PixelOutbound() {
		t.Fatal("openai-image aspect_ratio must be pixel outbound")
	}
	if (ImageSizeDeclaration{Parameter: "aspect_ratio", InterfaceType: "grok-image"}).PixelOutbound() {
		t.Fatal("other legacy interfaces must stay ratio outbound")
	}
}

func TestNormalizeDeclaredImageRatio(t *testing.T) {
	for input, want := range map[string]string{"32:18": "16:9", "16:9": "16:9", "1536x864": "16:9", "": ""} {
		if got := NormalizeDeclaredImageRatio(input); got != want {
			t.Fatalf("NormalizeDeclaredImageRatio(%q) = %q, want %q", input, got, want)
		}
	}
}
