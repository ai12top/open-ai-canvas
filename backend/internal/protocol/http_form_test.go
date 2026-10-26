package protocol

import (
	"slices"
	"testing"
)

func TestFormValuesExpandArraysIntoRepeatedFields(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  []string
	}{
		{name: "nil is dropped", value: nil},
		{name: "string passes through", value: "a cat", want: []string{"a cat"}},
		{name: "bool", value: true, want: []string{"true"}},
		{name: "integral float keeps no decimal", value: float64(2), want: []string{"2"}},
		{name: "fractional float", value: 2.5, want: []string{"2.5"}},
		{name: "int", value: 7, want: []string{"7"}},
		{name: "string array expands in order", value: []any{"x", "y"}, want: []string{"x", "y"}},
		{name: "nested arrays flatten and drop nils", value: []any{"a", nil, []any{"b", 2.0}, false, "c"}, want: []string{"a", "b", "2", "false", "c"}},
		{name: "objects fall back to json", value: map[string]any{"k": "v"}, want: []string{`{"k":"v"}`}},
		{name: "non empty array of objects stays one entry each", value: []any{map[string]any{"k": 1}}, want: []string{`{"k":1}`}},
		{name: "unencodable value is dropped", value: make(chan int)},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := FormValues(testCase.value); !slices.Equal(got, testCase.want) {
				t.Fatalf("FormValues(%#v) = %#v, want %#v", testCase.value, got, testCase.want)
			}
		})
	}
}

func TestFormValuesKeepDecodedJSONNumbers(t *testing.T) {
	// manifest body 经过 encoding/json 解码后数字是 float64；宿主与浏览器都走这里。
	body := map[string]any{"count": float64(4), "tags": []any{"a", "b"}, "nested": []any{1.5, "z"}}
	if got := FormValues(body["count"]); !slices.Equal(got, []string{"4"}) {
		t.Fatalf("count = %v", got)
	}
	if got := FormValues(body["tags"]); !slices.Equal(got, []string{"a", "b"}) {
		t.Fatalf("tags = %v", got)
	}
	if got := FormValues(body["nested"]); !slices.Equal(got, []string{"1.5", "z"}) {
		t.Fatalf("nested = %v", got)
	}
}
