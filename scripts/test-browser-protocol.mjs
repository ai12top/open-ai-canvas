#!/usr/bin/env node
// Real Go/WASM execution against shipped manifests; no HTTP or credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(process.argv[2] ?? resolve(root, 'web/public/browser-protocol'));
await import(pathToFileURL(resolve(artifacts, 'wasm_exec.js')).href);
globalThis.fetch = () => { throw new Error('smoke test forbids HTTP'); };
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(await readFile(resolve(artifacts, 'protocol.wasm')), go.importObject);
void go.run(instance);
assert.equal(typeof globalThis.yingceBrowserProtocol, 'function');

const load = async (name) => JSON.parse(await readFile(resolve(root, 'plugin-packages', name, 'manifest.json'), 'utf8'));
const call = (op, manifest, input = {}) => {
  const reply = JSON.parse(globalThis.yingceBrowserProtocol(JSON.stringify({ op, manifest, ...input })));
  assert.equal(reply.ok, true, reply.error);
  return reply.data;
};

const image = await load('openai-images');
assert.equal(call('load', image).providerId, 'openai-image');
const imageRequest = {
  model: 'gpt-image-1', prompt: 'WASM fixture', imageCount: 2,
  images: [{ url: 'https://example.test/reference.png' }],
  providerOptions: { 'openai-image': { output_format: 'webp' } },
};
const imageSpec = call('buildCreate', image, { request: imageRequest });
assert.equal(imageSpec.path, '/v1/images/edits');
assert.equal(imageSpec.body.n, 2);
assert.equal(imageSpec.body.output_format, 'webp');
assert.deepEqual(imageSpec.body.images, [{ image_url: 'https://example.test/reference.png' }]);
assert.deepEqual(imageSpec.auth, { type: 'bearer', field: 'apiKey' });
assert.equal(imageSpec.headers?.Authorization, undefined);
const imageResult = call('parseCreate', image, { body: { data: [{ b64_json: 'aGVsbG8=' }], usage: { total_tokens: 3 } } });
assert.equal(imageResult.status, 'succeeded');
assert.equal(imageResult.result.images[0].dataUrl, 'data:image/png;base64,aGVsbG8=');
assert.equal(imageResult.result.usage.total_tokens, 3);

const video = await load('newapi-media-task-v1');
assert.equal(call('describe', video).operations.poll, true);
const create = call('buildCreate', video, { request: {
  model: 'video-fixture', prompt: 'WASM fixture', duration: 8, aspectRatio: '9:16', resolution: '1080P',
  images: [{ url: 'https://example.test/frame.png', role: 'first_frame' }],
  providerOptions: { 'newapi-channel-1': { prompt_extend: true } },
} });
assert.equal(create.path, '/v1/videos');
assert.equal(create.body.input.media[0].type, 'first_frame');
assert.equal(create.body.parameters.duration, 8);
assert.equal(create.body.parameters.ratio, '9:16');
assert.equal(create.body.parameters.prompt_extend, true);
const created = call('parseCreate', video, { body: '{"id":"fixture-task","status":"queued"}' });
assert.equal(created.taskId, 'fixture-task');
assert.equal(created.status, 'pending');
const poll = call('buildPoll', video, { taskId: created.taskId });
assert.equal(poll.path, '/v1/videos/fixture-task');
assert.equal(poll.method, 'GET');
const polled = call('parsePoll', video, { taskId: created.taskId, body: {
  status: 'completed', video_url: 'https://example.test/output.mp4',
} });
assert.equal(polled.taskId, 'fixture-task');
assert.equal(polled.status, 'succeeded');
assert.equal(polled.result.videos[0].url, 'https://example.test/output.mp4');
assert.equal(polled.result.videos[0].ephemeral, true);
const failed = call('parsePoll', video, { taskId: created.taskId, body: {
  status: 'failed', error: { code: 'fixture-error', message: 'fixture upstream failure' },
} });
assert.equal(failed.status, 'failed');
assert.equal(failed.message, 'fixture upstream failure');

const multipart = await load('openai-videos');
const multipartSpec = call('buildCreate', multipart, { request: { model: 'sora-2', prompt: 'WASM fixture', duration: 8 } });
assert.equal(multipartSpec.contentType, 'multipart/form-data');
assert.equal(multipartSpec.body.model, 'sora-2');

// Optional cancellation/result request translation stays pure, too.
const extended = structuredClone(video);
extended.contributes.providers[0].cancel = { method: 'DELETE', path: '/v1/videos/{{taskId}}' };
extended.contributes.providers[0].result = { method: 'GET', path: '/v1/videos/{{taskId}}/content' };
assert.equal(call('buildCancel', extended, { taskId: 'fixture-task' }).method, 'DELETE');
assert.equal(call('buildResult', extended, { taskId: 'fixture-task' }).path, '/v1/videos/fixture-task/content');

for (const backend of ['host:fixture', 'rpc', 'wasm', 'trusted-backend']) {
  const blocked = structuredClone(video);
  blocked.runtime = { backend };
  assert.equal(JSON.parse(globalThis.yingceBrowserProtocol(JSON.stringify({ op: 'load', manifest: blocked }))).ok, false);
}
for (const type of ['query', 'aws-sigv4', 'tc3', 'volcengine-v4']) {
  const blocked = structuredClone(video);
  blocked.contributes.providers[0].auth.type = type;
  assert.equal(JSON.parse(globalThis.yingceBrowserProtocol(JSON.stringify({ op: 'load', manifest: blocked }))).ok, false);
}
assert.equal(JSON.parse(globalThis.yingceBrowserProtocol('{')).ok, false);
assert.equal(JSON.parse(globalThis.yingceBrowserProtocol(1)).ok, false);
assert.equal(call('describe', image).providerId, 'openai-image');
console.log('Browser protocol Go/WASM smoke passed: shipped image expressions, JSON/base64 response, async create/poll/error, multipart, cancel/result translation, unsupported runtime/auth rejection; no HTTP.');
