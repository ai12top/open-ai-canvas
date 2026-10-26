import { afterEach, describe, expect, test } from "bun:test";

import { callBrowserProtocol, ensureBrowserProtocolBridge, resetBrowserProtocolBridge } from "../src/services/api/browser-protocol";

afterEach(() => {
    resetBrowserProtocolBridge();
    delete globalThis.Go;
});

describe("browser protocol bridge", () => {
    test("reuses an existing Go bridge and forwards one JSON call", async () => {
        const sent: string[] = [];
        globalThis.yingceBrowserProtocol = (input: string) => {
            sent.push(input);
            return JSON.stringify({ ok: true, data: { operations: { create: true } } });
        };

        await expect(ensureBrowserProtocolBridge()).resolves.toBeUndefined();
        await expect(callBrowserProtocol({ op: "describe", manifest: { apiVersion: "yingce.plugin/v2" } })).resolves.toEqual({ operations: { create: true } });
        expect(JSON.parse(sent[0] || "{}")).toMatchObject({ op: "describe", manifest: { apiVersion: "yingce.plugin/v2" } });
    });

    test("turns a Go error envelope into a plain error with the original text", async () => {
        globalThis.yingceBrowserProtocol = () => JSON.stringify({ ok: false, error: 'parse poll: unsupported status "queued"' });
        await expect(callBrowserProtocol({ op: "parsePoll", manifest: {} })).rejects.toThrow('parse poll: unsupported status "queued"');
    });

    test("rejects malformed and throwing bridges without inventing a reply", async () => {
        globalThis.yingceBrowserProtocol = () => "not json";
        await expect(callBrowserProtocol({ op: "load", manifest: {} })).rejects.toThrow("无法解析");

        globalThis.yingceBrowserProtocol = () => {
            throw new Error("runtime closed");
        };
        await expect(callBrowserProtocol({ op: "load", manifest: {} })).rejects.toThrow("浏览器协议执行失败：runtime closed");
    });

    test("requires a browser realm with the static runtime assets", async () => {
        delete globalThis.yingceBrowserProtocol;
        await expect(ensureBrowserProtocolBridge()).rejects.toThrow("当前环境不支持加载浏览器协议运行时");
        // 失败不缓存：第二次调用仍然走加载流程而不是复用被拒绝的单例。
        await expect(ensureBrowserProtocolBridge()).rejects.toThrow("当前环境不支持加载浏览器协议运行时");
    });
});
