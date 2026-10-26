package protocol

import (
	"encoding/base64"
	"slices"
	"strings"
	"testing"
)

// headerLookup 模拟 http.Header.Get 的大小写不敏感语义。
func headerLookup(existing map[string]string) func(string) string {
	return func(name string) string {
		for key, value := range existing {
			if strings.EqualFold(key, name) {
				return value
			}
		}
		return ""
	}
}

func authHeaderValues(headers []AuthHeader) [][2]string {
	result := make([][2]string, 0, len(headers))
	for _, header := range headers {
		result = append(result, [2]string{header.Name, header.Value})
	}
	return result
}

func TestHeaderAuthProjectsManifestAuth(t *testing.T) {
	basic := func(username, password string) string {
		return "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
	}
	credentials := Credentials{APIKey: "  sk-key  ", SecretKey: "  sk-secret  "}
	cases := []struct {
		name      string
		auth      ManifestAuth
		apiFormat string
		existing  map[string]string
		want      [][2]string
		handled   bool
	}{
		{name: "empty type keeps bearer default", handled: true,
			want: [][2]string{{"Authorization", "Bearer   sk-key  "}}},
		{name: "empty type keeps claude default", apiFormat: "claude", handled: true,
			want: [][2]string{{"x-api-key", "  sk-key  "}, {"anthropic-version", "2023-06-01"}}},
		{name: "empty type keeps gemini default", apiFormat: "gemini", handled: true,
			want: [][2]string{{"x-goog-api-key", "  sk-key  "}}},
		{name: "none declares no credentials", auth: ManifestAuth{Type: "none"}, apiFormat: "claude", handled: true},
		{name: "bearer defaults", auth: ManifestAuth{Type: "bearer", Field: "apiKey"}, handled: true,
			want: [][2]string{{"Authorization", "Bearer sk-key"}}},
		{name: "bearer honours header prefix and field", auth: ManifestAuth{Type: "Bearer", Field: "secretKey", Header: " x-api-key ", Prefix: "Token "}, handled: true,
			want: [][2]string{{"x-api-key", "Token sk-secret"}}},
		{name: "header type requires a name", auth: ManifestAuth{Type: "header", Field: "apiKey"}, handled: true},
		{name: "header type joins prefix", auth: ManifestAuth{Type: "header", Field: "apiKey", Header: " X-Key ", Prefix: "K-"}, handled: true,
			want: [][2]string{{"X-Key", "K-sk-key"}}},
		{name: "api-key alias", auth: ManifestAuth{Type: "api-key", Field: "apiKey", Header: "x-api-key"}, handled: true,
			want: [][2]string{{"x-api-key", "sk-key"}}},
		{name: "apikey alias", auth: ManifestAuth{Type: "apikey", Field: "apiKey", Header: "x-api-key", Prefix: "pre-"}, handled: true,
			want: [][2]string{{"x-api-key", "pre-sk-key"}}},
		{name: "basic falls back to the field credential", auth: ManifestAuth{Type: "basic", Field: "apiKey"}, handled: true,
			want: [][2]string{{"Authorization", basic("sk-key", "sk-key")}}},
		{name: "basic uses explicit username and secret field", auth: ManifestAuth{Type: "basic", Username: "alice", Field: "apiKey", SecretField: "secretKey"}, handled: true,
			want: [][2]string{{"Authorization", basic("alice", "sk-secret")}}},
		{name: "basic secret field alias defaults to the api key", auth: ManifestAuth{Type: "basic", Field: "apiKey", SecretField: "apiKey"}, handled: true,
			want: [][2]string{{"Authorization", basic("sk-key", "sk-key")}}},
		{name: "anthropic supplies the version default", auth: ManifestAuth{Type: "anthropic", Field: "apiKey"}, handled: true,
			want: [][2]string{{"x-api-key", "sk-key"}, {"anthropic-version", "2023-06-01"}}},
		{name: "anthropic keeps an explicit version", auth: ManifestAuth{Type: "anthropic", Field: "apiKey"},
			existing: map[string]string{"Anthropic-Version": "2024-01-01"}, handled: true,
			want: [][2]string{{"x-api-key", "sk-key"}}},
		{name: "anthropic custom header still defaults the version", auth: ManifestAuth{Type: "anthropic", Field: "apiKey", Header: "x-custom-key"}, handled: true,
			want: [][2]string{{"x-custom-key", "sk-key"}, {"anthropic-version", "2023-06-01"}}},
		{name: "google-api-key defaults", auth: ManifestAuth{Type: "google-api-key", Field: "apiKey"}, handled: true,
			want: [][2]string{{"x-goog-api-key", "sk-key"}}},
		{name: "gemini honours a custom header", auth: ManifestAuth{Type: "gemini", Field: "apiKey", Header: "x-custom-google"}, handled: true,
			want: [][2]string{{"x-custom-google", "sk-key"}}},
		{name: "query stays host side", auth: ManifestAuth{Type: "query", Field: "apiKey", Query: "key"}},
		{name: "aws sigv4 stays host side", auth: ManifestAuth{Type: "aws-sigv4", Field: "apiKey"}},
		{name: "tc3 stays host side", auth: ManifestAuth{Type: "tc3", Field: "apiKey"}},
		{name: "volcengine v4 stays host side", auth: ManifestAuth{Type: "volcengine-v4", Field: "apiKey"}},
		{name: "unknown driver stays host side", auth: ManifestAuth{Type: "mystery", Field: "apiKey"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			headers, handled, err := HeaderAuth(testCase.auth, credentials, testCase.apiFormat, headerLookup(testCase.existing))
			if handled != testCase.handled {
				t.Fatalf("handled = %v, want %v", handled, testCase.handled)
			}
			if wantErr := testCase.name == "header type requires a name"; wantErr {
				if err == nil || err.Error() != "插件 header 鉴权缺少 header 名称" {
					t.Fatalf("err = %v, want the published header-name error", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got := authHeaderValues(headers); !slices.Equal(got, testCase.want) {
				t.Fatalf("headers = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestHeaderAuthAnthropicGuardsItsOwnPendingVersion(t *testing.T) {
	// header 名恰好是 anthropic-version 时，先写入的凭据头本身就算“已存在”，
	// 不能再补默认版本（否则会覆盖凭据），与宿主先 Set 再 Get 的语义保持一致。
	headers, _, err := HeaderAuth(ManifestAuth{Type: "anthropic", Field: "apiKey", Header: "anthropic-version"}, Credentials{APIKey: "sk-key"}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := authHeaderValues(headers); !slices.Equal(got, [][2]string{{"anthropic-version", "sk-key"}}) {
		t.Fatalf("headers = %v, want the credential only", got)
	}
}

func TestCredentialsResolveManifestFieldAliases(t *testing.T) {
	credentials := Credentials{APIKey: "  key  ", SecretKey: "  secret  "}
	for _, field := range []string{"", "apiKey", "api_key", "apikey", "token"} {
		if got := credentials.Credential(field); got != "key" {
			t.Fatalf("Credential(%q) = %q, want key", field, got)
		}
	}
	for _, field := range []string{"secret", "secretKey", "secret_key", " SecretField "} {
		want := "secret"
		if field == " SecretField " {
			// 未知别名按宿主行为回退到 APIKey。
			want = "key"
		}
		if got := credentials.Credential(field); got != want {
			t.Fatalf("Credential(%q) = %q, want %q", field, got, want)
		}
	}
}

func TestDefaultAuthHeadersMatchPublishedBehaviour(t *testing.T) {
	// apiFormat 与凭据都不做 trim/大小写折叠，保持宿主既有输出。
	credentials := Credentials{APIKey: " sk "}
	cases := map[string][][2]string{
		"claude":            {{"x-api-key", " sk "}, {"anthropic-version", "2023-06-01"}},
		"gemini":            {{"x-goog-api-key", " sk "}},
		"openai":            {{"Authorization", "Bearer  sk "}},
		"":                  {{"Authorization", "Bearer  sk "}},
		"Claude":            {{"Authorization", "Bearer  sk "}},
		"gemini-chat":       {{"Authorization", "Bearer  sk "}},
		" claude":           {{"Authorization", "Bearer  sk "}},
		"openai-compatible": {{"Authorization", "Bearer  sk "}},
	}
	for apiFormat, want := range cases {
		if got := authHeaderValues(DefaultAuthHeaders(apiFormat, credentials)); !slices.Equal(got, want) {
			t.Fatalf("DefaultAuthHeaders(%q) = %v, want %v", apiFormat, got, want)
		}
	}
}
