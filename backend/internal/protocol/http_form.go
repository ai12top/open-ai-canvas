// 声明式插件表单字段展开的共享纯规则：宿主 urlencoded/multipart 编码器与浏览器
// WASM bridge 共用，数组必须展开成重复字段而不是 JSON 字符串。

package protocol

import (
	"encoding/json"
	"strconv"
)

// FormValues 把 manifest body 里的一个值展开成表单条目：数组按顺序递归展开为重复字段，
// 标量沿用宿主既有格式，其它结构回退到 JSON（失败则丢弃该字段）。
func FormValues(value any) []string {
	switch typed := value.(type) {
	case nil:
		return nil
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			result = append(result, FormValues(item)...)
		}
		return result
	case string:
		return []string{typed}
	case bool:
		return []string{strconv.FormatBool(typed)}
	case float64:
		return []string{strconv.FormatFloat(typed, 'f', -1, 64)}
	case int:
		return []string{strconv.Itoa(typed)}
	default:
		data, err := json.Marshal(typed)
		if err != nil {
			return nil
		}
		return []string{string(data)}
	}
}
