// 声明式协议插件的鉴权：Bearer/Header/Basic 等纯头部规则与浏览器共用
// protocol.HeaderAuth；Query、AWS SigV4、腾讯云 TC3 与火山 V4 签名只在宿主执行。

package app

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/volcengine/volc-sdk-golang/base"
	"yingce/backend/internal/protocol"
)

func applyProtocolAuth(req *http.Request, config providerConfig, auth protocol.ManifestAuth) error {
	credentials := protocolAuthCredentials(config)
	// 不需要宿主机能力的头部规则（含空 type 的 apiFormat 默认头）与浏览器共用同一份实现。
	headers, handled, err := protocol.HeaderAuth(auth, credentials, config.APIFormat, req.Header.Get)
	if err != nil {
		return err
	}
	if handled {
		for _, header := range headers {
			req.Header.Set(header.Name, header.Value)
		}
		return nil
	}
	typeName := strings.ToLower(strings.TrimSpace(auth.Type))
	credential := credentials.Credential(auth.Field)
	switch typeName {
	case "query":
		name := defaultString(strings.TrimSpace(auth.Query), strings.TrimSpace(auth.Field))
		if name == "" {
			return errors.New("插件 query 鉴权缺少参数名")
		}
		query := req.URL.Query()
		query.Set(name, auth.Prefix+credential)
		req.URL.RawQuery = query.Encode()
		return nil
	case "volcengine-v4":
		secret := credentials.Credential(auth.SecretField)
		if credential == "" || secret == "" {
			return errors.New("火山引擎 V4 鉴权需要 Access Key 和 Secret Key")
		}
		volcCredentials := base.Credentials{
			AccessKeyID: credential, SecretAccessKey: secret,
			Region:  defaultString(strings.TrimSpace(auth.Region), "cn-north-1"),
			Service: strings.TrimSpace(auth.Service),
		}
		if volcCredentials.Service == "" {
			return errors.New("火山引擎 V4 鉴权缺少 service")
		}
		signed := volcCredentials.Sign(req)
		*req = *signed
		return nil
	case "aws-sigv4":
		secret := credentials.Credential(auth.SecretField)
		return signProtocolAWSV4(req, credential, secret, auth)
	case "tc3":
		secret := credentials.Credential(auth.SecretField)
		return signProtocolTC3(req, credential, secret, auth)
	default:
		return fmt.Errorf("插件声明了尚未启用的鉴权驱动 %s", auth.Type)
	}
}

func signProtocolAWSV4(req *http.Request, accessKey, secretKey string, auth protocol.ManifestAuth) error {
	if strings.TrimSpace(accessKey) == "" || strings.TrimSpace(secretKey) == "" {
		return errors.New("AWS SigV4 鉴权需要 Access Key ID 和 Secret Access Key")
	}
	serviceName := defaultString(strings.TrimSpace(auth.Service), "bedrock")
	region := strings.TrimSpace(auth.Region)
	if region == "" {
		parts := strings.Split(strings.ToLower(req.URL.Hostname()), ".")
		for index, part := range parts {
			if strings.HasPrefix(part, serviceName) && index+1 < len(parts) {
				region = parts[index+1]
				break
			}
		}
	}
	if region == "" {
		return errors.New("AWS SigV4 鉴权无法从 Base URL 推断 region，请使用包含区域的 Bedrock Runtime 地址")
	}
	payload, err := protocolRequestPayload(req)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	payloadHash := sha256Hex(payload)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	canonicalHeaders, signedHeaders := protocolCanonicalHeaders(req)
	canonicalRequest := strings.Join([]string{
		req.Method,
		defaultString(req.URL.EscapedPath(), "/"),
		req.URL.Query().Encode(),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")
	scope := strings.Join([]string{dateStamp, region, serviceName, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex([]byte(canonicalRequest))}, "\n")
	dateKey := protocolHMAC([]byte("AWS4"+secretKey), dateStamp)
	regionKey := protocolHMAC(dateKey, region)
	serviceKey := protocolHMAC(regionKey, serviceName)
	signingKey := protocolHMAC(serviceKey, "aws4_request")
	signature := hex.EncodeToString(protocolHMAC(signingKey, stringToSign))
	req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", accessKey, scope, signedHeaders, signature))
	return nil
}

func signProtocolTC3(req *http.Request, secretID, secretKey string, auth protocol.ManifestAuth) error {
	if strings.TrimSpace(secretID) == "" || strings.TrimSpace(secretKey) == "" {
		return errors.New("腾讯云 TC3 鉴权需要 SecretId 和 SecretKey")
	}
	serviceName := defaultString(strings.TrimSpace(auth.Service), "hunyuan")
	payload, err := protocolRequestPayload(req)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	timestamp := now.Unix()
	dateStamp := now.Format("2006-01-02")
	contentType := defaultString(req.Header.Get("Content-Type"), "application/json")
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-TC-Timestamp", strconv.FormatInt(timestamp, 10))
	if region := strings.TrimSpace(auth.Region); region != "" {
		req.Header.Set("X-TC-Region", region)
	}
	canonicalHeaders := "content-type:" + strings.ToLower(strings.TrimSpace(contentType)) + "\n" + "host:" + strings.ToLower(req.URL.Host) + "\n"
	signedHeaders := "content-type;host"
	canonicalRequest := strings.Join([]string{req.Method, defaultString(req.URL.EscapedPath(), "/"), req.URL.Query().Encode(), canonicalHeaders, signedHeaders, sha256Hex(payload)}, "\n")
	scope := dateStamp + "/" + serviceName + "/tc3_request"
	stringToSign := strings.Join([]string{"TC3-HMAC-SHA256", strconv.FormatInt(timestamp, 10), scope, sha256Hex([]byte(canonicalRequest))}, "\n")
	secretDate := protocolHMAC([]byte("TC3"+secretKey), dateStamp)
	secretService := protocolHMAC(secretDate, serviceName)
	secretSigning := protocolHMAC(secretService, "tc3_request")
	signature := hex.EncodeToString(protocolHMAC(secretSigning, stringToSign))
	req.Header.Set("Authorization", fmt.Sprintf("TC3-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", secretID, scope, signedHeaders, signature))
	return nil
}

func protocolRequestPayload(req *http.Request) ([]byte, error) {
	if req.Body == nil {
		return nil, nil
	}
	var reader io.ReadCloser
	var err error
	if req.GetBody != nil {
		reader, err = req.GetBody()
	} else {
		reader = req.Body
	}
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(reader)
	if req.GetBody != nil {
		_ = reader.Close()
	} else {
		req.Body = io.NopCloser(bytes.NewReader(data))
	}
	return data, err
}

func protocolCanonicalHeaders(req *http.Request) (string, string) {
	values := map[string]string{"host": strings.ToLower(req.URL.Host)}
	for name, entries := range req.Header {
		lower := strings.ToLower(strings.TrimSpace(name))
		if lower == "authorization" || lower == "user-agent" || lower == "content-length" || lower == "expect" {
			continue
		}
		cleaned := make([]string, 0, len(entries))
		for _, entry := range entries {
			cleaned = append(cleaned, strings.Join(strings.Fields(entry), " "))
		}
		values[lower] = strings.Join(cleaned, ",")
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var canonical strings.Builder
	for _, key := range keys {
		canonical.WriteString(key)
		canonical.WriteByte(':')
		canonical.WriteString(values[key])
		canonical.WriteByte('\n')
	}
	return canonical.String(), strings.Join(keys, ";")
}

func protocolHMAC(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

func sha256Hex(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}

// protocolAuthCredentials 把渠道配置投影成单次请求的瞬时凭据；字段别名解析在 protocol 侧统一。
func protocolAuthCredentials(config providerConfig) protocol.Credentials {
	return protocol.Credentials{APIKey: config.APIKey, SecretKey: config.SecretKey}
}

func protocolCredentialField(config providerConfig, field string) string {
	return protocolAuthCredentials(config).Credential(field)
}

func protocolRequestURL(baseURL string, spec protocol.RequestSpec) (string, error) {
	if !spec.OriginPath {
		return appendProtocolQuery(apiURL(baseURL, spec.Path), spec.Query)
	}
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("协议根路径请求的 Base URL 无效")
	}
	requestPath, err := url.Parse(spec.Path)
	if err != nil || !strings.HasPrefix(requestPath.Path, "/") {
		return "", fmt.Errorf("协议根路径请求必须使用绝对路径")
	}
	base.Path = requestPath.Path
	base.RawPath = requestPath.RawPath
	base.RawQuery = requestPath.RawQuery
	base.Fragment = ""
	return appendProtocolQuery(base.String(), spec.Query)
}
