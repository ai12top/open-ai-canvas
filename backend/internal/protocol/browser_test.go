package protocol

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func browserFixture(t *testing.T) Manifest {
	t.Helper()
	var manifest Manifest
	if err := json.Unmarshal([]byte(`{"apiVersion":"yingce.plugin/v2","id":"browser-fixture","name":"Browser fixture","version":"1.0.0","configuration":{"fields":[{"name":"not-execution-data","type":"secret","default":"must-not-distribute"}]},"contributes":{"providers":[{"id":"first","label":"First","capabilities":["image"],"scopes":["user.custom-channel"],"auth":{"type":"bearer","field":"apiKey"},"validations":[{"assert":{"$ne":[{"$ref":"request.prompt"},""]},"message":"prompt is required"}],"create":{"method":"POST","path":"/images","body":{"prompt":{"$ref":"request.prompt"}}},"response":{"status":"succeeded","resultUrlPaths":["url"],"resultKind":"image"}},{"id":"second","label":"Second","capabilities":["video"],"scopes":["user.custom-channel"],"create":{"method":"POST","path":"/videos"},"response":{}}]}}`), &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func TestBrowserProviderManifestPreservesProviderAndUsesOriginalLoader(t *testing.T) {
	manifest := browserFixture(t)
	projected, err := BrowserProviderManifest(manifest, "first")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(projected)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "must-not-distribute") || len(projected.Contributes.Providers) != 1 || projected.Metadata.ID != manifest.Metadata.ID {
		t.Fatalf("projection leaked non-execution data: %s", raw)
	}
	originalProvider, _ := json.Marshal(manifest.Contributes.Providers[0])
	projectedProvider, _ := json.Marshal(projected.Contributes.Providers[0])
	if string(originalProvider) != string(projectedProvider) {
		t.Fatal("projection lost provider execution fields")
	}
	adapters, err := LoadInstalledProviders(raw, nil)
	if err != nil || len(adapters) != 1 || adapters[0].Metadata().ID != "first" {
		t.Fatalf("original loader rejected projection: %v", err)
	}
	if _, err := adapters[0].BuildCreate(context.Background(), RequestContext{}); err == nil || err.Error() != "prompt is required" {
		t.Fatalf("original Go validation was bypassed: %v", err)
	}
	if _, err := BrowserProviderManifest(manifest, ""); err == nil {
		t.Fatal("multi-provider input silently selected first provider")
	}
}

func TestBrowserProviderManifestRejectsNonBrowserExecution(t *testing.T) {
	for _, backend := range []string{"host:openai-image", "rpc", "wasm", "trusted-backend"} {
		t.Run(backend, func(t *testing.T) {
			manifest := browserFixture(t)
			manifest.Runtime.Backend = backend
			if _, err := BrowserProviderManifest(manifest, "first"); err == nil || !strings.Contains(err.Error(), "declarative") {
				t.Fatalf("unsupported runtime accepted: %v", err)
			}
		})
	}
	for _, auth := range []string{"query", "aws-sigv4", "tc3", "volcengine-v4", "unknown"} {
		t.Run(auth, func(t *testing.T) {
			manifest := browserFixture(t)
			manifest.Contributes.Providers[0].Auth.Type = auth
			if _, err := BrowserProviderManifest(manifest, "first"); err == nil {
				t.Fatal("unsupported auth accepted")
			}
		})
	}
	for _, auth := range []string{"", "none", "bearer", "header", "api-key", "apikey", "basic", "anthropic", "google-api-key", "gemini"} {
		manifest := browserFixture(t)
		manifest.Contributes.Providers[0].Auth.Type = auth
		if _, err := BrowserProviderManifest(manifest, "first"); err != nil {
			t.Fatalf("supported auth %q rejected: %v", auth, err)
		}
	}
	manifest := browserFixture(t)
	manifest.Metadata.Enabled = false
	if _, err := BrowserProviderManifest(manifest, "first"); err == nil {
		t.Fatal("disabled plugin accepted")
	}
	manifest = browserFixture(t)
	manifest.Contributes.Providers[0].Scopes = []Surface{SurfaceAdminSystemChannel}
	if _, err := BrowserProviderManifest(manifest, "first"); err == nil {
		t.Fatal("system-only provider accepted")
	}
	manifest = browserFixture(t)
	manifest.Contributes.Providers[0].Capabilities = []Capability{CapabilityText}
	if _, err := BrowserProviderManifest(manifest, "first"); err == nil || !strings.Contains(err.Error(), "image/video") {
		t.Fatalf("non-media browser provider accepted: %v", err)
	}
	for _, response := range []ManifestResponse{{BinaryPayload: true}, {StreamedJSONAudio: true}} {
		manifest = browserFixture(t)
		manifest.Contributes.Providers[0].Response = response
		if _, err := BrowserProviderManifest(manifest, "first"); err == nil || !strings.Contains(err.Error(), "JSON media responses") {
			t.Fatalf("binary/streaming browser provider accepted: %v", err)
		}
	}
	manifest = browserFixture(t)
	manifest.Contributes.Providers[0].Create.Path = "https://example.test/images"
	if _, err := BrowserProviderManifest(manifest, "first"); err == nil || !strings.Contains(err.Error(), "path must be relative") {
		t.Fatalf("original manifest validation bypassed: %v", err)
	}
}
