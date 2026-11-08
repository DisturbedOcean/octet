import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ai from '../shims/ai.mjs';
import { configureLocalPi } from '../shims/local-pi.mjs';
import { withNativeProvider } from '../lib/native-provider.mjs';
import { rememberReply, restoreReplies } from '../lib/extension-signatures.mjs';
import { registerProvider } from '../lib/providers.mjs';

const STREAMS = ['streamAnthropic', 'streamSimpleAnthropic', 'streamGoogle', 'streamSimpleGoogle', 'streamOpenAICompletions', 'streamSimpleOpenAICompletions'];

// Managed install whose legacy stream aliases report which installed function ran.
function installedPi(t) {
  const version = '1.0.2';
  const agent = mkdtempSync(join(tmpdir(), 'octet-provider-streams-'));
  t.after(() => { configureLocalPi(undefined); rmSync(agent, { recursive: true, force: true }); });
  mkdirSync(join(agent, 'install'), { recursive: true });
  writeFileSync(join(agent, 'install', 'current-version'), `${version}\n`);
  for (const name of ['pi-coding-agent', 'pi-ai', 'pi-tui', 'pi-agent-core']) {
    const dir = join(agent, 'install', 'releases', version, 'node_modules', '@earendil-works', name);
    mkdirSync(join(dir, 'dist', 'providers'), { recursive: true });
    const exports = { '.': { import: './dist/index.js' } };
    if (name === 'pi-ai') Object.assign(exports, { './compat': { import: './dist/index.js' }, './oauth': { import: './dist/index.js' }, './providers/*': { import: './dist/providers/*.js' } });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@earendil-works/${name}`, version, type: 'module', exports }));
    writeFileSync(join(dir, 'dist', 'index.js'), 'export {};\n');
    writeFileSync(join(dir, 'dist', 'providers', 'all.js'), 'export {};\n');
  }
  const aliases = STREAMS.map(name => `export const ${name} = (model, context, options) => ({ installed: '${name}', model: model.id, options });`).join('\n');
  writeFileSync(join(agent, 'install', 'releases', version, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'legacy-api-aliases.js'), `${aliases}\n`);
  configureLocalPi(agent);
}

test('Google and OpenAI-completions API factories run the installed Pi streams', t => {
  installedPi(t);
  const model = { id: 'extension-model' }, options = { headers: { authorization: 'Bearer extension-owned' } };
  for (const [factory, prefix] of [[ai.googleGenerativeAIApi, 'Google'], [ai.openAICompletionsApi, 'OpenAICompletions']]) {
    const api = factory();
    assert.deepEqual(api.stream(model, {}, options), { installed: `stream${prefix}`, model: model.id, options });
    assert.deepEqual(api.streamSimple(model, {}, options), { installed: `streamSimple${prefix}`, model: model.id, options });
  }
});

test('Anthropic API factory runs the installed Pi stream only for an extension-owned provider request', t => {
  installedPi(t);
  const model = { id: 'extension-claude', api: 'anthropic-messages' }, options = { apiKey: 'unused' };
  const job = { entry: { inherited: false, config: { baseUrl: 'https://gateway.invalid' } } };
  const api = ai.anthropicMessagesApi();
  assert.deepEqual(withNativeProvider({}, job, () => api.streamSimple(model, { messages: [] }, options)), { installed: 'streamSimpleAnthropic', model: model.id, options });
  assert.deepEqual(withNativeProvider({}, job, () => api.stream(model, { messages: [] }, options)), { installed: 'streamAnthropic', model: model.id, options });
  assert.throws(() => api.streamSimple(model, { messages: [] }, options), /admitted provider request/);
});

test('an extension reply is replayed with the thinking and signatures the host never received', () => {
  const owner = {};
  const reply = [
    { type: 'thinking', thinking: '[Reasoning redacted]', thinkingSignature: 'opaque', redacted: true },
    { type: 'thinking', thinking: 'plan', thinkingSignature: 'sig-thinking' },
    { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
  ];
  rememberReply(owner, { role: 'assistant', provider: 'gateway-anthropic', model: 'claude', content: reply });
  const replayed = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', model: 'claude', api: 'anthropic-messages', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }] },
    { role: 'assistant', model: 'other', api: 'anthropic-messages', content: [{ type: 'text', text: 'unrelated' }] },
  ];
  const [user, restored, untouched] = restoreReplies(owner, replayed);
  assert.equal(user, replayed[0]);
  assert.equal(untouched, replayed[2]);
  assert.equal(restored.provider, 'gateway-anthropic');
  assert.deepEqual(restored.content, reply);
});

test('signatures on visible parts are restored when the host replays a changed reply', () => {
  const owner = {};
  rememberReply(owner, { role: 'assistant', provider: 'gateway-gemini', model: 'gemini', content: [
    { type: 'thinking', thinking: 'plan', thinkingSignature: 'sig-thinking' },
    { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {}, thoughtSignature: 'sig-tool' },
    { type: 'toolCall', id: 'call-2', name: 'bash', arguments: {} },
  ] });
  const [restored] = restoreReplies(owner, [{ role: 'assistant', model: 'gemini', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }] }]);
  assert.equal(restored.provider, 'gateway-gemini');
  assert.equal(restored.content[0].thinkingSignature, 'sig-thinking');
  assert.equal(restored.content[1].thoughtSignature, 'sig-tool');
});

test('activation-time discovery registers a Pi 1.5 provider after its load scope ends', async () => {
  const frames = [], pending = [];
  const runtime = { initialized: true, stopping: false, features: new Set(['provider_proxy_v1']), require() {},
    current() { throw new Error('not_foreground_owner retained context is unavailable'); },
    track: promise => { pending.push(promise); return promise; }, scope: { run: (_, fn) => fn() },
    backgroundError: error => { throw error; },
    transport: { request: async (method, params) => { frames.push({ method, params }); return { revision: 1 }; }, notify: async () => {} } };
  const chat = { id: 'claude', name: 'Claude', reasoning: true, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100, compat: { forceAdaptiveThinking: true }, headers: undefined };
  const image = { id: 'painter', name: 'Painter', type: 'image', input: ['text'], output: ['image'] };
  registerProvider(runtime, 0, 'gateway-anthropic', { name: 'Model Gateway', baseUrl: 'https://gateway.invalid', apiKey: 'unused', api: 'anthropic-messages', models: [chat, image], streamSimple() {}, refreshModels() {}, images: {} });
  registerProvider(runtime, 0, 'gateway-openai', { api: 'openai-completions', models: [], streamSimple() {} });
  await Promise.all(pending);
  assert.deepEqual(frames.map(frame => frame.method), ['providers/register']);
  assert.equal(frames[0].params.provider.label, 'Model Gateway');
  assert.deepEqual(frames[0].params.models.map(model => model.api_name), ['claude']);
});
