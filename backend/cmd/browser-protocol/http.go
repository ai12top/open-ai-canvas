package main

import (
	"fmt"
	"sort"
	"strings"

	"yingce/backend/internal/protocol"
)

type formEntry struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type preparedHTTP struct {
	Headers    []protocol.AuthHeader `json:"headers"`
	FormValues []formEntry           `json:"formValues,omitempty"`
}

// Only transport-ready values cross the bridge; credentials stay on this call.
func prepareHTTP(call bridgeCall, providerAuth protocol.ManifestAuth) (preparedHTTP, error) {
	auth := call.Spec.Auth
	if auth.Type == "" {
		auth = providerAuth
	}
	headers, handled, err := protocol.HeaderAuth(auth, call.Credentials, call.APIFormat, func(name string) string {
		for key, value := range call.Spec.Headers {
			if strings.EqualFold(key, name) {
				return value
			}
		}
		return ""
	})
	if err != nil {
		return preparedHTTP{}, err
	}
	if !handled {
		return preparedHTTP{}, fmt.Errorf("browser execution does not support auth %q", auth.Type)
	}
	result := preparedHTTP{Headers: headers}
	contentType := strings.ToLower(strings.TrimSpace(strings.SplitN(call.Spec.ContentType, ";", 2)[0]))
	if len(call.Spec.Files) == 0 && contentType != "application/x-www-form-urlencoded" && contentType != "multipart/form-data" {
		return result, nil
	}
	body, ok := call.Spec.Body.(map[string]any)
	if !ok {
		return result, nil
	}
	keys := make([]string, 0, len(body))
	for name := range body {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	for _, name := range keys {
		for _, value := range protocol.FormValues(body[name]) {
			result.FormValues = append(result.FormValues, formEntry{Name: name, Value: value})
		}
	}
	return result, nil
}
