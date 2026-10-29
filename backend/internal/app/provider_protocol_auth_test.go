package app

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"

	"yingce/backend/internal/protocol"
)

func newProtocolAuthRequest(existing map[string]string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "https://api.example.com/v1/chat/completions", nil)
	for name, value := range existing {
		req.Header.Set(name, value)
	}
	return req
}

// 宿主保持既有语义：轻量鉴权分支与浏览器插件共用 protocol.HeaderAuth。
func TestApplyProtocolAuthDelegatesHeaderRules(t *testing.T) {
	basic := func(username, password string) string {
		return "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
	}
	cases := []struct {
		name     string
		auth     protocol.ManifestAuth
		config   providerConfig
		existing map[string]string
		want     map[string]string
		absent   []string
		wantErr  string
	}{
		{
			name:   "empty type keeps claude defaults",
			config: providerConfig{APIKey: "sk-claude", APIFormat: "claude"},
			want:   map[string]string{"x-api-key": "sk-claude", "anthropic-version": "2023-06-01"},
		},
		{
			name:   "empty type keeps gemini defaults",
			config: providerConfig{APIKey: "sk-gemini", APIFormat: "gemini"},
			want:   map[string]string{"x-goog-api-key": "sk-gemini"},
			absent: []string{"Authorization"},
		},
		{
			name:   "empty type keeps bearer defaults",
			config: providerConfig{APIKey: "sk-openai"},
			want:   map[string]string{"Authorization": "Bearer sk-openai"},
		},
		{
			name:   "none sets nothing even with an api key",
			auth:   protocol.ManifestAuth{Type: "none"},
			config: providerConfig{APIKey: "sk-claude", APIFormat: "claude"},
			absent: []string{"Authorization", "x-api-key", "anthropic-version"},
		},
		{
			name:   "bearer honours manifest header and prefix",
			auth:   protocol.ManifestAuth{Type: "bearer", Field: "secretKey", Header: "x-api-key", Prefix: "Token "},
			config: providerConfig{APIKey: "sk-key", SecretKey: " sk-secret "},
			want:   map[string]string{"x-api-key": "Token sk-secret"},
			absent: []string{"Authorization"},
		},
		{
			name:     "bearer overwrites an existing authorization header",
			auth:     protocol.ManifestAuth{Type: "bearer", Field: "apiKey"},
			config:   providerConfig{APIKey: "sk-key"},
			existing: map[string]string{"Authorization": "Bearer stale"},
			want:     map[string]string{"Authorization": "Bearer sk-key"},
		},
		{
			name:    "header type without a name keeps the published error",
			auth:    protocol.ManifestAuth{Type: "header", Field: "apiKey"},
			config:  providerConfig{APIKey: "sk-key"},
			wantErr: "插件 header 鉴权缺少 header 名称",
		},
		{
			name:   "header type joins prefix",
			auth:   protocol.ManifestAuth{Type: "header", Field: "apiKey", Header: " X-Key ", Prefix: "K-"},
			config: providerConfig{APIKey: "sk-key"},
			want:   map[string]string{"X-Key": "K-sk-key"},
		},
		{
			name:     "anthropic keeps an existing version header",
			auth:     protocol.ManifestAuth{Type: "anthropic", Field: "apiKey"},
			config:   providerConfig{APIKey: "sk-key"},
			existing: map[string]string{"anthropic-version": "2024-06-01"},
			want:     map[string]string{"x-api-key": "sk-key", "anthropic-version": "2024-06-01"},
		},
		{
			name:   "basic falls back to the field credential for both halves",
			auth:   protocol.ManifestAuth{Type: "basic", Field: "apiKey"},
			config: providerConfig{APIKey: " sk-key "},
			want:   map[string]string{"Authorization": basic("sk-key", "sk-key")},
		},
		{
			name:   "basic uses username and secret field",
			auth:   protocol.ManifestAuth{Type: "basic", Username: "alice", Field: "apiKey", SecretField: "secretKey"},
			config: providerConfig{APIKey: "sk-key", SecretKey: "sk-secret"},
			want:   map[string]string{"Authorization": basic("alice", "sk-secret")},
		},
		{
			name:   "google-api-key keeps the default header",
			auth:   protocol.ManifestAuth{Type: "google-api-key", Field: "apiKey"},
			config: providerConfig{APIKey: " sk-key "},
			want:   map[string]string{"x-goog-api-key": "sk-key"},
		},
		{
			name:    "unknown driver keeps the published error",
			auth:    protocol.ManifestAuth{Type: "mystery", Field: "apiKey"},
			config:  providerConfig{APIKey: "sk-key"},
			wantErr: "插件声明了尚未启用的鉴权驱动 mystery",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			req := newProtocolAuthRequest(testCase.existing)
			err := applyProtocolAuth(req, testCase.config, testCase.auth)
			if testCase.wantErr != "" {
				if err == nil || err.Error() != testCase.wantErr {
					t.Fatalf("err = %v, want %q", err, testCase.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			for name, want := range testCase.want {
				if got := req.Header.Get(name); got != want {
					t.Fatalf("%s = %q, want %q", name, got, want)
				}
			}
			for _, name := range testCase.absent {
				if got := req.Header.Get(name); got != "" {
					t.Fatalf("%s = %q, want absent", name, got)
				}
			}
		})
	}
}

func TestApplyProtocolAuthQueryStaysHostSide(t *testing.T) {
	req := newProtocolAuthRequest(nil)
	if err := applyProtocolAuth(req, providerConfig{APIKey: " sk-key "}, protocol.ManifestAuth{Type: "query", Field: "apiKey", Query: "key", Prefix: "pre-"}); err != nil {
		t.Fatal(err)
	}
	if got := req.URL.Query().Get("key"); got != "pre-sk-key" {
		t.Fatalf("query key = %q, want pre-sk-key", got)
	}
	if got := req.Header.Get("Authorization"); got != "" {
		t.Fatalf("Authorization = %q, want absent", got)
	}
}

// applyProviderAuth 仍是 manifest 缺省鉴权时的兜底，规则与浏览器默认头一致。
func TestApplyProviderAuthMatchesSharedDefaults(t *testing.T) {
	for _, apiFormat := range []string{"", "openai", "claude", "gemini"} {
		config := providerConfig{APIKey: "sk-key", APIFormat: apiFormat}
		req := newProtocolAuthRequest(nil)
		applyProviderAuth(req, config)
		want := protocol.DefaultAuthHeaders(apiFormat, protocolAuthCredentials(config))
		if len(want) != len(req.Header) {
			t.Fatalf("%s headers = %v, want %d entries", apiFormat, req.Header, len(want))
		}
		for _, header := range want {
			if got := req.Header.Get(header.Name); got != header.Value {
				t.Fatalf("%s %s = %q, want %q", apiFormat, header.Name, got, header.Value)
			}
		}
	}
}

func TestProtocolFormValuesDelegatesToSharedRules(t *testing.T) {
	if got := protocolFormValues([]any{"a", nil, []any{"b", 2.0}, true}); len(got) != 4 || got[0] != "a" || got[1] != "b" || got[2] != "2" || got[3] != "true" {
		t.Fatalf("form values = %#v", got)
	}
	if got := protocolFormValues(nil); len(got) != 0 {
		t.Fatalf("form values = %#v, want empty", got)
	}
	if got := protocolFormValues(map[string]any{"k": "v"}); len(got) != 1 || got[0] != `{"k":"v"}` {
		t.Fatalf("form values = %#v", got)
	}
}
