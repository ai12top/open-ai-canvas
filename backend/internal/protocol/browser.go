package protocol

import (
	"fmt"
	"strings"
)

// BrowserProviderManifest projects one complete declarative provider using the
// existing manifest contract. It does not grant credentials or HTTP access;
// the browser transport still owns authentication, CORS and request execution.
func BrowserProviderManifest(manifest Manifest, providerID string) (Manifest, error) {
	if err := ValidateManifest(manifest); err != nil {
		return Manifest{}, err
	}
	if !manifest.Metadata.Enabled {
		return Manifest{}, fmt.Errorf("plugin is disabled")
	}
	if backend := strings.TrimSpace(manifest.Runtime.Backend); backend != "" && backend != "declarative" {
		return Manifest{}, fmt.Errorf("browser execution requires a declarative provider; backend %q is unsupported", backend)
	}
	providerID = strings.TrimSpace(providerID)
	if providerID == "" && len(manifest.Contributes.Providers) == 1 {
		providerID = manifest.Contributes.Providers[0].ID
	}
	for _, provider := range manifest.Contributes.Providers {
		if provider.ID != providerID {
			continue
		}
		media := false
		for _, capability := range provider.Capabilities {
			media = media || capability == CapabilityImage || capability == CapabilityVideo
		}
		if !media {
			return Manifest{}, fmt.Errorf("browser execution currently supports image/video providers only")
		}
		if provider.Response.BinaryPayload || provider.Response.StreamedJSONAudio {
			return Manifest{}, fmt.Errorf("browser execution requires JSON media responses; binary/streamed responses are unsupported")
		}
		personal := false
		for _, scope := range provider.Scopes {
			personal = personal || scope == SurfaceUserCustomChannel
		}
		if !personal {
			return Manifest{}, fmt.Errorf("provider %q is not available for user.custom-channel", providerID)
		}
		switch strings.ToLower(strings.TrimSpace(provider.Auth.Type)) {
		case "", "none", "bearer", "header", "api-key", "apikey", "basic", "anthropic", "google-api-key", "gemini":
		case "query":
			return Manifest{}, fmt.Errorf("browser execution does not allow credentials in query parameters")
		default:
			return Manifest{}, fmt.Errorf("browser execution does not support auth %q (host signing is unavailable)", provider.Auth.Type)
		}
		return Manifest{
			APIVersion: manifest.APIVersion,
			Metadata: Metadata{
				ID: manifest.Metadata.ID, Name: manifest.Metadata.Name,
				Version: manifest.Metadata.Version, Vendor: manifest.Metadata.Vendor,
				Enabled: true,
			},
			Runtime:     ManifestRuntime{Backend: "declarative"},
			Contributes: ManifestContributions{Providers: []ManifestProvider{provider}},
		}, nil
	}
	return Manifest{}, fmt.Errorf("browser provider %q is missing; select a providerId", providerID)
}
