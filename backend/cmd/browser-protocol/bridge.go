package main

import (
	"context"
	"encoding/json"
	"fmt"

	"yingce/backend/internal/protocol"
)

type bridgeCall struct {
	Op          string                         `json:"op"`
	Manifest    protocol.Manifest              `json:"manifest"`
	ProviderID  string                         `json:"providerId"`
	BaseURL     string                         `json:"baseUrl"`
	Request     protocol.GenerationRequest     `json:"request"`
	Model       string                         `json:"model"`
	TaskID      string                         `json:"taskId"`
	Metadata    map[string]any                 `json:"metadata"`
	Body        json.RawMessage                `json:"body"`
	ImageSize   *protocol.ImageSizeDeclaration `json:"imageSize,omitempty"`
	Spec        protocol.RequestSpec           `json:"spec"`
	Credentials protocol.Credentials           `json:"credentials"`
	APIFormat   string                         `json:"apiFormat"`
}

type bridgeReply struct {
	OK    bool   `json:"ok"`
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

// Each call is stateless: only the original Go loader and Adapter translate
// protocol JSON. No HTTP client, credential source or task runtime is involved.
func invoke(input string) (output string) {
	defer func() {
		if recover() != nil {
			output = encodeReply(nil, fmt.Errorf("protocol bridge failed"))
		}
	}()
	var call bridgeCall
	if err := json.Unmarshal([]byte(input), &call); err != nil {
		return encodeReply(nil, fmt.Errorf("decode bridge input: %w", err))
	}
	data, err := execute(call)
	return encodeReply(data, err)
}

func encodeReply(data any, err error) string {
	reply := bridgeReply{OK: err == nil, Data: data}
	if err != nil {
		reply.Data, reply.Error = nil, err.Error()
	}
	encoded, marshalErr := json.Marshal(reply)
	if marshalErr != nil {
		return `{"ok":false,"error":"encode bridge output failed"}`
	}
	return string(encoded)
}

func execute(call bridgeCall) (any, error) {
	if call.Op == "normalizeImage" {
		if call.ImageSize == nil {
			return call.Request, nil
		}
		return protocol.NormalizeImageRequest(call.Request, *call.ImageSize)
	}
	manifest, err := protocol.BrowserProviderManifest(call.Manifest, call.ProviderID)
	if err != nil {
		return nil, fmt.Errorf("load browser provider: %w", err)
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return nil, fmt.Errorf("encode browser manifest: %w", err)
	}
	adapters, err := protocol.LoadInstalledProviders(raw, nil)
	if err != nil {
		return nil, fmt.Errorf("load browser manifest: %w", err)
	}
	adapter := adapters[0]
	provider := manifest.Contributes.Providers[0]
	ctx := context.Background()
	model := call.Model
	if model == "" {
		model = call.Request.Model
	}
	poll := protocol.PollContext{BaseURL: call.BaseURL, Model: model, Request: call.Request, TaskID: call.TaskID, Metadata: call.Metadata}
	switch call.Op {
	case "prepareHTTP":
		return prepareHTTP(call, provider.Auth)
	case "load", "describe":
		return struct {
			ProviderID string            `json:"providerId"`
			Metadata   protocol.Metadata `json:"metadata"`
			Operations map[string]bool   `json:"operations"`
		}{provider.ID, adapter.Metadata(), map[string]bool{
			"create": true, "poll": provider.Poll != nil,
			"cancel": provider.Cancel != nil, "result": provider.Result != nil,
		}}, nil
	case "buildCreate":
		return adapter.BuildCreate(ctx, protocol.RequestContext{BaseURL: call.BaseURL, Request: call.Request})
	case "buildPoll", "buildCancel", "buildResult", "parsePoll":
		if call.TaskID == "" {
			return nil, fmt.Errorf("%s requires taskId", call.Op)
		}
		switch call.Op {
		case "buildPoll":
			return adapter.BuildPoll(ctx, poll)
		case "buildCancel":
			return adapter.BuildCancel(ctx, poll)
		case "buildResult":
			resultAdapter, ok := adapter.(protocol.ResultAdapter)
			if !ok {
				return nil, fmt.Errorf("provider has no result operation")
			}
			return resultAdapter.BuildResult(ctx, poll)
		default:
			body, err := responseBody(call.Body)
			if err != nil {
				return nil, err
			}
			return adapter.ParsePoll(ctx, poll, body)
		}
	case "parseCreate":
		body, err := responseBody(call.Body)
		if err != nil {
			return nil, err
		}
		if parser, ok := adapter.(protocol.RequestAwareCreateParser); ok {
			return parser.ParseCreateWithRequest(ctx, call.Request, body)
		}
		return adapter.ParseCreate(ctx, body)
	default:
		return nil, fmt.Errorf("unsupported browser protocol operation %q", call.Op)
	}
}

func responseBody(raw json.RawMessage) ([]byte, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, fmt.Errorf("response body is required")
	}
	if raw[0] == '"' {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return nil, fmt.Errorf("decode response text: %w", err)
		}
		return []byte(text), nil
	}
	return raw, nil
}
