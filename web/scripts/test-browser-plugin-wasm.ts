// Run after scripts/build-browser-protocol.sh: bun web/scripts/test-browser-plugin-wasm.ts
// Real TS projection -> real Go/WASM -> real TS transport; only outbound HTTP is replaced.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import axios from "axios";
import { browserPluginRequest } from "../src/services/browser-plugin-request";
import { createBrowserPluginTask, pluginDownloadRequest, type BrowserPluginManifest } from "../src/services/api/browser-plugin";
import { defaultImageCapabilityConfig, defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import type { ImageParameter } from "../src/lib/image-parameters";
import type { ChannelTransportConfig } from "../src/services/api/channel-transport";

const root = resolve(import.meta.dir, "../..");
await import(pathToFileURL(resolve(root, "web/public/browser-protocol/wasm_exec.js")).href);
const go = new globalThis.Go!();
const { instance } = await WebAssembly.instantiate(await readFile(resolve(root, "web/public/browser-protocol/protocol.wasm")), go.importObject);
void go.run(instance);
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, options?: RequestInit) => {
    if (String(input).startsWith("data:")) return originalFetch(input, options);
    throw new Error("offline contract test forbids HTTP");
}) as typeof fetch;
const sent: Array<Record<string, unknown>> = [];
axios.request = (async (config: Record<string, unknown>) => {
    sent.push(config);
    return { data: { data: [{ b64_json: "aGVsbG8=" }] } };
}) as typeof axios.request;

const parameters: ImageParameter[] = [
    { name: "size", label: "Size", type: "string", binding: "aspectRatio", encoding: "pixels", values: ["16:9"], default: "16:9" },
    { name: "imageResolution", label: "Resolution", type: "string", binding: "resolution", values: ["1k"], default: "1k" },
    { name: "count", label: "Count", type: "integer", binding: "imageCount", min: 1, max: 4, default: 2 },
];
const manifest = JSON.parse(await readFile(resolve(root, "plugin-packages/openai-images/manifest.json"), "utf8")) as BrowserPluginManifest;
const provider = manifest.contributes!.providers![0];
provider.imageParameters = parameters;
const capabilityConfig = defaultModelCapabilityConfig("openai-image");
capabilityConfig.image = {
    ...defaultImageCapabilityConfig("openai-image"), parameters,
    size: { parameter: "aspect_ratio", values: ["16:9"], default: "16:9", allowCustom: false, presets: [{ tier: "1k", ratio: "16:9", size: "1536x864" }] },
    resolution: { supported: true, values: ["1k"], default: "1k" },
    quality: { supported: false, values: [], default: "auto" },
};
const channel = createModelChannel({
    id: "offline-fixture", scope: "user", apiFormat: "openai", interfaceType: "openai-image",
    baseUrl: "https://fixture.invalid/v1", apiKey: "synthetic-fixture-key", models: ["fixture-image"],
    modelCosts: [{ model: "fixture-image", capability: "image", protocol: "openai-image", capabilityConfig, billingMode: "fixed_request", unitPriceMicrocredits: 0 }],
});
const config = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "fixture-image"), size: "16:9", imageResolution: "1k", count: "2" };
const transport: ChannelTransportConfig = { ...channel, channelScope: "user" };
const request = await browserPluginRequest({ config, mode: "image", prompt: "offline fixture" });
assert.equal(request.aspectRatio, "1536x864");
assert.equal(request.output?.aspectRatio, "1536x864");
assert.equal(request.imageCount, 2);
assert.ok(!JSON.stringify(request).includes("synthetic-fixture-key"));
await createBrowserPluginTask(transport, manifest, request);
assert.equal((sent.at(-1)!.data as Record<string, unknown>).size, "1536x864");
assert.equal((sent.at(-1)!.data as Record<string, unknown>).n, 2);
const legacyCapabilities = structuredClone(capabilityConfig);
delete legacyCapabilities.image!.parameters;
const legacyChannel = { ...channel, modelCosts: [{ ...channel.modelCosts![0], capabilityConfig: legacyCapabilities }] };
const legacyRequest = await browserPluginRequest({ config: { ...config, channels: [legacyChannel] }, mode: "image", prompt: "legacy offline fixture" });
assert.equal(legacyRequest.aspectRatio, "1536x864");
const disabledCapabilities = structuredClone(capabilityConfig);
Object.assign(disabledCapabilities.image!.parameters!.find((field) => field.name === "imageResolution")!, { enabled: false, default: "2k" });
disabledCapabilities.image!.resolution.supported = false;
disabledCapabilities.image!.size.presets!.push({ tier: "2k", ratio: "16:9", size: "2560x1440", width: 2560, height: 1440 });
const disabledChannel = { ...channel, modelCosts: [{ ...channel.modelCosts![0], capabilityConfig: disabledCapabilities }] };
const disabledRequest = await browserPluginRequest({ config: { ...config, channels: [disabledChannel], imageResolution: "auto" }, mode: "image", prompt: "disabled tier fixture" });
assert.equal(disabledRequest.aspectRatio, "2560x1440");
assert.equal(disabledRequest.resolution, undefined);

for (const [auth, expected] of [
    [{ type: "none" }, {}],
    [{ type: "bearer", header: "X-Token", prefix: "Token " }, { "x-token": "Token synthetic-fixture-key" }],
    [{ type: "basic", username: "用户", secretField: "secretKey" }, { authorization: `Basic ${Buffer.from("用户:").toString("base64")}` }],
    [{ type: "anthropic" }, { "x-api-key": "synthetic-fixture-key", "anthropic-version": "2023-06-01" }],
] as const) {
    provider.auth = auth;
    await createBrowserPluginTask(transport, manifest, request);
    const headers = sent.at(-1)!.headers as Record<string, string>;
    for (const [name, value] of Object.entries(expected)) assert.equal(headers[name], value);
    if (!("authorization" in expected)) assert.equal(headers.authorization, undefined);
}
provider.auth = { type: "none" };
const noneDownload = await pluginDownloadRequest(transport, manifest, "https://fixture.invalid/v1/files/out.png");
assert.equal(noneDownload.headers.authorization, undefined);
provider.auth = { type: "bearer" };
const cdnDownload = await pluginDownloadRequest(transport, manifest, "https://cdn.invalid/out.png");
assert.deepEqual(cdnDownload.headers, {});

provider.create = { method: "POST", path: "/form", contentType: "application/x-www-form-urlencoded", body: { tags: ["one", "two"], enabled: false, count: 0 } };
await createBrowserPluginTask(transport, manifest, request);
const form = new URLSearchParams(sent.at(-1)!.data as string);
assert.deepEqual(form.getAll("tags"), ["one", "two"]);
assert.equal(form.get("enabled"), "false");
assert.equal(form.get("count"), "0");

provider.create = {
    method: "POST", path: "/multipart", contentType: "multipart/form-data", body: { tags: ["one", "two"] },
    files: [{ name: "image", filename: "fixture.jpg", mimeType: "image/jpeg", source: { $ref: "request.images" } }],
};
await createBrowserPluginTask(transport, manifest, { ...request, images: [{ dataUrl: "data:application/octet-stream;base64,aGVsbG8=" }] });
const multipart = sent.at(-1)!.data as FormData;
assert.deepEqual(multipart.getAll("tags"), ["one", "two"]);
assert.equal((multipart.get("image") as File).type, "image/jpeg");
assert.equal((multipart.get("image") as File).name, "fixture.jpg");

console.log("PASS: real TS → Go/WASM → transport; pixel size/count, none/custom/basic/Anthropic auth, repeated form fields, upload MIME, CDN credential isolation; no HTTP");
