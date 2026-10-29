package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"yingce/backend/internal/protocol"
)

func browserCatalogService(t *testing.T, mutate func(*protocol.Manifest), status string) (*Service, protocol.Manifest) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "openai-images", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest protocol.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if mutate != nil {
		mutate(&manifest)
	}
	raw, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := protocol.NewRegistry()
	if err != nil {
		t.Fatal(err)
	}
	center := &pluginRuntime{registry: registry, plugins: map[string]pluginRecord{
		manifest.Metadata.ID: {Raw: raw, Metadata: manifest.Metadata, Status: status, Source: PluginOriginUploaded},
	}}
	return &Service{pluginRuntime: center}, manifest
}

func TestProviderCatalogBrowserManifestIsExecutableOriginalDefinition(t *testing.T) {
	svc, source := browserCatalogService(t, nil, "enabled")
	items := svc.PluginProviderCatalog(string(protocol.SurfaceUserCustomChannel), "image", false)
	if len(items) != 1 || items[0].BrowserManifest == nil || items[0].BrowserUnsupportedReason != "" {
		t.Fatalf("missing browser execution definition: %#v", items)
	}
	item := items[0]
	if item.ID != "openai-image" || item.Create != "POST /v1/images/generations" || !item.Enabled {
		t.Fatalf("legacy catalog fields changed: %#v", item)
	}
	manifest := *item.BrowserManifest
	if manifest.Metadata.ID != source.Metadata.ID || manifest.Metadata.Version != source.Metadata.Version || len(manifest.Contributes.Providers) != 1 {
		t.Fatalf("plugin identity or provider projection lost: %#v", manifest)
	}
	if !reflect.DeepEqual(manifest.Contributes.Providers[0], source.Contributes.Providers[0]) {
		t.Fatal("full provider definition did not survive catalog projection")
	}
	raw, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		BrowserManifest json.RawMessage `json:"browserManifest"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	adapters, err := protocol.LoadInstalledProviders(wire.BrowserManifest, nil)
	if err != nil || len(adapters) != 1 {
		t.Fatalf("catalog wire not accepted by original loader: %v", err)
	}
	spec, err := adapters[0].BuildCreate(context.Background(), protocol.RequestContext{Request: protocol.GenerationRequest{Model: "gpt-image-1", Prompt: "catalog fixture"}})
	if err != nil || spec.Path != "/v1/images/generations" || spec.Auth.Type != "bearer" {
		t.Fatalf("catalog manifest is not executable: %#v, %v", spec, err)
	}
	if len(manifest.Configuration.Fields) != 0 || manifest.Metadata.Documentation != "" {
		t.Fatal("catalog distributed non-execution plugin data")
	}
}

func TestProviderCatalogOmitsUnsupportedBrowserDefinitions(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*protocol.Manifest)
		status string
	}{
		{"host", func(m *protocol.Manifest) { m.Runtime.Backend = "host:openai-image" }, "enabled"},
		{"rpc", func(m *protocol.Manifest) { m.Runtime.Backend = "rpc" }, "enabled"},
		{"signing", func(m *protocol.Manifest) { m.Contributes.Providers[0].Auth.Type = "aws-sigv4" }, "enabled"},
		{"query-key", func(m *protocol.Manifest) { m.Contributes.Providers[0].Auth.Type = "query" }, "enabled"},
		{"binary", func(m *protocol.Manifest) { m.Contributes.Providers[0].Response.BinaryPayload = true }, "enabled"},
		{"streaming", func(m *protocol.Manifest) { m.Contributes.Providers[0].Response.StreamedJSONAudio = true }, "enabled"},
		{"system-only", func(m *protocol.Manifest) {
			m.Contributes.Providers[0].Scopes = []protocol.Surface{protocol.SurfaceAdminSystemChannel}
		}, "enabled"},
		{"disabled", nil, "disabled"},
		{"invalid", nil, "invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc, _ := browserCatalogService(t, test.mutate, test.status)
			items := svc.PluginProviderCatalog(string(protocol.SurfaceAdminSystemChannel), "image", true)
			if len(items) != 1 || items[0].BrowserManifest != nil || items[0].BrowserUnsupportedReason == "" {
				t.Fatalf("unsupported execution advertised: %#v", items)
			}
			raw, _ := json.Marshal(items[0])
			if strings.Contains(string(raw), `"browserManifest"`) || !strings.Contains(string(raw), `"browserUnsupportedReason"`) {
				t.Fatalf("optional fields wrong: %s", raw)
			}
			if test.status != "enabled" && len(svc.PluginProviderCatalog(string(protocol.SurfaceAdminSystemChannel), "image", false)) != 0 {
				t.Fatal("existing availability filter changed")
			}
		})
	}
}
