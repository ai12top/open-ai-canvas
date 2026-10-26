package main

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

func fixtureManifest(t *testing.T, name string) protocol.Manifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", name, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest protocol.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func callBridge(t *testing.T, call bridgeCall) map[string]any {
	t.Helper()
	raw, err := json.Marshal(call)
	if err != nil {
		t.Fatal(err)
	}
	var reply struct {
		OK    bool           `json:"ok"`
		Data  map[string]any `json:"data"`
		Error string         `json:"error"`
	}
	if err := json.Unmarshal([]byte(invoke(string(raw))), &reply); err != nil {
		t.Fatal(err)
	}
	if !reply.OK {
		t.Fatalf("%s failed: %s", call.Op, reply.Error)
	}
	return reply.Data
}

func TestBridgeUsesOriginalLoaderAndImageExpressions(t *testing.T) {
	manifest := fixtureManifest(t, "openai-images")
	request := protocol.GenerationRequest{
		Model: "gpt-image-1", Prompt: "bridge fixture", ImageCount: 2,
		Images:          []protocol.MediaReference{{URL: "https://example.test/reference.png"}},
		ProviderOptions: map[string]map[string]any{"openai-image": {"output_format": "webp"}},
	}
	data := callBridge(t, bridgeCall{Op: "buildCreate", Manifest: manifest, Request: request})
	if data["path"] != "/v1/images/edits" || data["body"].(map[string]any)["output_format"] != "webp" {
		t.Fatalf("dynamic image mapping lost: %#v", data)
	}
	raw, _ := json.Marshal(manifest)
	adapters, err := protocol.LoadInstalledProviders(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := adapters[0].BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(spec)
	var expected map[string]any
	if err := json.Unmarshal(encoded, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(data, expected) {
		t.Fatalf("bridge differs from original adapter: got %#v, want %#v", data, expected)
	}
	result := callBridge(t, bridgeCall{Op: "parseCreate", Manifest: manifest, Body: json.RawMessage(`{"data":[{"b64_json":"aGVsbG8="}],"usage":{"total_tokens":3}}`)})
	image := result["result"].(map[string]any)["images"].([]any)[0].(map[string]any)
	if result["status"] != "succeeded" || image["dataUrl"] != "data:image/png;base64,aGVsbG8=" {
		t.Fatalf("image response mapping lost: %#v", result)
	}
}

func TestBridgeAsyncCreatePollAndRawResponseText(t *testing.T) {
	manifest := fixtureManifest(t, "newapi-media-task-v1")
	description := callBridge(t, bridgeCall{Op: "describe", Manifest: manifest})
	if description["providerId"] != "newapi-channel-1" || description["operations"].(map[string]any)["poll"] != true {
		t.Fatalf("bad description: %#v", description)
	}
	created := callBridge(t, bridgeCall{Op: "parseCreate", Manifest: manifest, Body: json.RawMessage(`"{\"id\":\"fixture-task\",\"status\":\"queued\"}"`)})
	if created["taskId"] != "fixture-task" || created["status"] != "pending" {
		t.Fatalf("bad create response: %#v", created)
	}
	poll := callBridge(t, bridgeCall{Op: "buildPoll", Manifest: manifest, TaskID: "fixture-task"})
	if poll["method"] != "GET" || poll["path"] != "/v1/videos/fixture-task" {
		t.Fatalf("bad poll request: %#v", poll)
	}
	result := callBridge(t, bridgeCall{Op: "parsePoll", Manifest: manifest, TaskID: "fixture-task", Body: json.RawMessage(`{"status":"completed","video_url":"https://example.test/fixture.mp4"}`)})
	video := result["result"].(map[string]any)["videos"].([]any)[0].(map[string]any)
	if result["taskId"] != "fixture-task" || result["status"] != "succeeded" || video["url"] != "https://example.test/fixture.mp4" || video["ephemeral"] != true {
		t.Fatalf("bad poll result: %#v", result)
	}
}

func TestBridgeFailuresStayJSONAndDoNotPoisonNextCall(t *testing.T) {
	manifest := fixtureManifest(t, "newapi-media-task-v1")
	for _, test := range []struct {
		name string
		call bridgeCall
		want string
	}{
		{"operation", bridgeCall{Op: "fetch", Manifest: manifest}, "unsupported browser protocol operation"},
		{"provider", bridgeCall{Op: "load", Manifest: manifest, ProviderID: "absent"}, "select a providerId"},
		{"task", bridgeCall{Op: "buildPoll", Manifest: manifest}, "requires taskId"},
		{"body", bridgeCall{Op: "parseCreate", Manifest: manifest}, "response body is required"},
		{"response", bridgeCall{Op: "parseCreate", Manifest: manifest, Body: json.RawMessage(`"not json"`)}, "not JSON"},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw, _ := json.Marshal(test.call)
			output := invoke(string(raw))
			var reply bridgeReply
			if err := json.Unmarshal([]byte(output), &reply); err != nil || reply.OK || !strings.Contains(reply.Error, test.want) {
				t.Fatalf("bad failure reply %q: %v", output, err)
			}
		})
	}
	if output := invoke("{"); !json.Valid([]byte(output)) || !strings.Contains(output, `"ok":false`) {
		t.Fatalf("invalid input escaped envelope: %s", output)
	}
	callBridge(t, bridgeCall{Op: "load", Manifest: manifest})
}
