import { createHash } from 'node:crypto';

// Provider events carry no opaque reasoning state, yet Anthropic and Gemini reject tool continuations whose signed thinking is missing.
// shortcut: in memory per adapter process and capped, so a restart replays that history unsigned; upgrade when provider events carry signatures.
const LIMIT = 4096;
const caches = new WeakMap();
const SIGNATURES = ['thinkingSignature', 'textSignature', 'thoughtSignature'];
const digest = value => createHash('sha256').update(value).digest('hex');

function keyOf(part) {
  if (part?.type === 'thinking' && part.thinking) return `thinking:${digest(part.thinking)}`;
  if (part?.type === 'text' && part.text) return `text:${digest(part.text)}`;
  if (part?.type === 'toolCall' && part.id) return `tool:${part.id}`;
  return undefined;
}

// Thinking the host never received is absent from its replay, so a whole reply is found by its visible parts.
function replyKey(content) {
  const visible = content.filter(part => part?.type !== 'thinking').map(keyOf);
  return visible.length && visible.every(Boolean) ? `reply:${visible.join('|')}` : undefined;
}

function remember(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
}

export function rememberReply(owner, message) {
  let cache = caches.get(owner);
  if (!cache) caches.set(owner, cache = new Map());
  const origin = { provider: message.provider, model: message.model };
  const reply = replyKey(message.content);
  if (reply) remember(cache, reply, { ...origin, content: structuredClone(message.content) });
  for (const part of message.content) {
    const key = keyOf(part);
    const signatures = Object.fromEntries(SIGNATURES.filter(field => typeof part[field] === 'string' && part[field]).map(field => [field, part[field]]));
    if (key && !part.redacted && Object.keys(signatures).length) remember(cache, key, { ...origin, signatures });
  }
  while (cache.size > LIMIT) cache.delete(cache.keys().next().value);
}

export function restoreReplies(owner, messages) {
  const cache = caches.get(owner);
  if (!cache) return messages;
  return messages.map(message => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
    const reply = cache.get(replyKey(message.content));
    if (reply) return { ...message, provider: reply.provider, model: reply.model, content: structuredClone(reply.content) };
    let origin;
    const content = message.content.map(part => {
      const hit = cache.get(keyOf(part));
      if (!hit?.signatures) return part;
      origin ??= hit;
      return { ...part, ...hit.signatures };
    });
    return origin ? { ...message, provider: origin.provider, model: origin.model, content } : message;
  });
}
