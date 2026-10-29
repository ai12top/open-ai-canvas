//go:build js && wasm

package main

import "syscall/js"

func main() {
	bridge := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeString {
			return `{"ok":false,"error":"expected one JSON string"}`
		}
		return invoke(args[0].String())
	})
	js.Global().Set("yingceBrowserProtocol", bridge)
	select {}
}
