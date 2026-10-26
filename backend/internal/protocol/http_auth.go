// 声明式插件鉴权的共享纯规则：宿主（internal/app）与浏览器 WASM bridge
// （cmd/browser-protocol）共用同一份实现，保证同一份 manifest 在两侧算出同一组请求头。
//
// 这里只做 manifest -> header 的纯投影：不接触 *http.Request、不拼 URL、不写 query、
// 不签名，也不读取或存储凭证。URL 校验、SSRF、超时、审计与签名仍全部留在宿主。

package protocol

import (
	"encoding/base64"
	"errors"
	"strings"
)

// Credentials 是单次请求的瞬时凭据投影，由调用方从当前渠道配置按值传入；
// 它不属于 manifest/catalog/handle，禁止持久化。
type Credentials struct {
	APIKey    string `json:"apiKey,omitempty"`
	SecretKey string `json:"secretKey,omitempty"`
}

// Credential 按协议字段既有别名取凭据：secret/secretKey/secret_key 取 SecretKey，
// 其余（含空字段、apiKey…）取 APIKey，并去掉首尾空白。宿主历史行为即如此。
func (c Credentials) Credential(field string) string {
	switch strings.ToLower(strings.TrimSpace(field)) {
	case "secretkey", "secret_key", "secret":
		return strings.TrimSpace(c.SecretKey)
	default:
		return strings.TrimSpace(c.APIKey)
	}
}

// AuthHeader 是一个待设置的请求头，切片顺序即写入顺序。
type AuthHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// HeaderAuth 把 manifest 声明的鉴权投影成请求头。空 type 沿用 apiFormat 默认头
// （见 DefaultAuthHeaders），避免浏览器侧再维护一份空类型兜底。
//
// existing 返回请求上已有的头值（语义上大小写不敏感，宿主可直接传 req.Header.Get），
// nil 视为没有任何已存在头。handled=false 表示该声明需要宿主侧能力
// （query / AWS SigV4 / TC3 / 火山 V4 / 未知驱动），调用方不得静默发出无鉴权请求。
func HeaderAuth(auth ManifestAuth, credentials Credentials, apiFormat string, existing func(string) string) ([]AuthHeader, bool, error) {
	switch strings.ToLower(strings.TrimSpace(auth.Type)) {
	case "":
		return DefaultAuthHeaders(apiFormat, credentials), true, nil
	case "none":
		// 声明了 none 就是明确不带凭据，不能回退到 apiFormat 默认头。
		return nil, true, nil
	case "bearer":
		name := strings.TrimSpace(auth.Header)
		if name == "" {
			name = "Authorization"
		}
		prefix := auth.Prefix
		if prefix == "" {
			prefix = "Bearer "
		}
		return []AuthHeader{{Name: name, Value: prefix + credentials.Credential(auth.Field)}}, true, nil
	case "header", "api-key", "apikey":
		name := strings.TrimSpace(auth.Header)
		if name == "" {
			return nil, true, errors.New("插件 header 鉴权缺少 header 名称")
		}
		return []AuthHeader{{Name: name, Value: auth.Prefix + credentials.Credential(auth.Field)}}, true, nil
	case "basic":
		username := auth.Username
		if username == "" {
			username = credentials.Credential(auth.Field)
		}
		password := credentials.Credential(auth.SecretField)
		token := base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
		return []AuthHeader{{Name: "Authorization", Value: "Basic " + token}}, true, nil
	case "anthropic":
		// header 名保持宿主原样（不 trim），与既有行为一致。
		name := auth.Header
		if name == "" {
			name = "x-api-key"
		}
		headers := []AuthHeader{{Name: name, Value: credentials.Credential(auth.Field)}}
		if lookupAuthHeader(existing, headers, "anthropic-version") == "" {
			headers = append(headers, AuthHeader{Name: "anthropic-version", Value: "2023-06-01"})
		}
		return headers, true, nil
	case "google-api-key", "gemini":
		name := auth.Header
		if name == "" {
			name = "x-goog-api-key"
		}
		return []AuthHeader{{Name: name, Value: credentials.Credential(auth.Field)}}, true, nil
	}
	return nil, false, nil
}

// DefaultAuthHeaders 返回 manifest 未声明 auth（type 为空）时的历史默认头：
// claude 走 x-api-key + 无条件 anthropic-version，gemini 走 x-goog-api-key，其余 Bearer。
// apiFormat 与宿主原样精确匹配（不 trim、不折叠大小写），凭据也不 trim，保持既有语义不变。
func DefaultAuthHeaders(apiFormat string, credentials Credentials) []AuthHeader {
	switch apiFormat {
	case "claude":
		return []AuthHeader{
			{Name: "x-api-key", Value: credentials.APIKey},
			{Name: "anthropic-version", Value: "2023-06-01"},
		}
	case "gemini":
		return []AuthHeader{{Name: "x-goog-api-key", Value: credentials.APIKey}}
	default:
		return []AuthHeader{{Name: "Authorization", Value: "Bearer " + credentials.APIKey}}
	}
}

// lookupAuthHeader 先看本次投影已排队的头，再问请求上已存在的头，保持宿主
// “先 Set 再 Get” 的顺序语义；头名比较按 HTTP 规则大小写不敏感。
func lookupAuthHeader(existing func(string) string, pending []AuthHeader, name string) string {
	for _, header := range pending {
		if strings.EqualFold(header.Name, name) {
			return header.Value
		}
	}
	if existing == nil {
		return ""
	}
	return existing(name)
}
