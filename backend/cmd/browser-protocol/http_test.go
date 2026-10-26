package main

import (
	"reflect"
	"testing"

	"yingce/backend/internal/protocol"
)

func TestBridgePreparesSharedAuthAndRepeatedFormValues(t *testing.T) {
	manifest := fixtureManifest(t, "openai-images")
	manifest.Contributes.Providers[0].Auth = protocol.ManifestAuth{Type: "bearer", Header: "X-Token", Prefix: "Token "}
	data := callBridge(t, bridgeCall{
		Op: "prepareHTTP", Manifest: manifest,
		Credentials: protocol.Credentials{APIKey: "fixture-key"},
		Spec: protocol.RequestSpec{ContentType: "application/x-www-form-urlencoded; charset=utf-8", Body: map[string]any{
			"tags": []any{"one", "two"}, "enabled": false, "absent": nil,
		}},
	})
	wantHeaders := []any{map[string]any{"name": "X-Token", "value": "Token fixture-key"}}
	wantForm := []any{
		map[string]any{"name": "enabled", "value": "false"},
		map[string]any{"name": "tags", "value": "one"},
		map[string]any{"name": "tags", "value": "two"},
	}
	if !reflect.DeepEqual(data["headers"], wantHeaders) || !reflect.DeepEqual(data["formValues"], wantForm) {
		t.Fatalf("HTTP preparation drift: %#v", data)
	}
	if _, exists := data["credentials"]; exists {
		t.Fatal("credentials leaked into HTTP preparation result")
	}
}

func TestBridgeHTTPHonorsNoneAndExistingAnthropicVersion(t *testing.T) {
	manifest := fixtureManifest(t, "openai-images")
	manifest.Contributes.Providers[0].Auth = protocol.ManifestAuth{Type: "bearer"}
	data := callBridge(t, bridgeCall{
		Op: "prepareHTTP", Manifest: manifest, Credentials: protocol.Credentials{APIKey: "fixture-key"},
		Spec: protocol.RequestSpec{Auth: protocol.ManifestAuth{Type: "none"}},
	})
	if data["headers"] != nil {
		t.Fatalf("explicit none became bearer: %#v", data)
	}
	data = callBridge(t, bridgeCall{
		Op: "prepareHTTP", Manifest: manifest, Credentials: protocol.Credentials{APIKey: "fixture-key"},
		Spec: protocol.RequestSpec{Auth: protocol.ManifestAuth{Type: "anthropic"}, Headers: map[string]string{"Anthropic-Version": "custom"}},
	})
	want := []any{map[string]any{"name": "x-api-key", "value": "fixture-key"}}
	if !reflect.DeepEqual(data["headers"], want) {
		t.Fatalf("existing version was overwritten: %#v", data)
	}
}

func TestBridgeNormalizesImageWithoutProviderRuntime(t *testing.T) {
	declaration := &protocol.ImageSizeDeclaration{
		Parameter: "aspect_ratio", UsesParameters: true, Encoding: "pixels", Values: []string{"16:9"},
		Presets:    []protocol.ImageSizePreset{{Ratio: "16:9", Tier: "1k", Size: "1536x864"}},
		Resolution: protocol.ImageTierDeclaration{Supported: true, Values: []string{"1k"}, Default: "1k"},
	}
	request := protocol.GenerationRequest{Capability: protocol.CapabilityImage, Model: "fixture-image", AspectRatio: "16:9", Resolution: "1k"}
	data := callBridge(t, bridgeCall{Op: "normalizeImage", Request: request, ImageSize: declaration})
	if data["aspectRatio"] != "1536x864" || data["output"].(map[string]any)["aspectRatio"] != "1536x864" {
		t.Fatalf("image normalization drift: %#v", data)
	}
}
