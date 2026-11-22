import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { AiError, aiEnabled, complete, setClientFactory } from '../src/ai/client.js';
import { draftEmail, triageThreads } from '../src/ai/tasks.js';
import { updateSettings } from '../src/settings.js';
import { fakeAi, freshDb } from './helpers.js';

beforeEach(() => {
  freshDb();
  delete process.env.ANTHROPIC_API_KEY;
});

test('AI is off until a key is saved', async () => {
  assert.equal(aiEnabled(), false);
  await assert.rejects(complete({ system: 's', prompt: 'p' }), (err) => err instanceof AiError && err.code === 'not_configured');
  updateSettings({ ai: { apiKey: 'sk-ant-test-0000000000000000' } });
  assert.equal(aiEnabled(), true);
});

test('requests use the chosen model, an effort level, and refusal fallback where supported', async () => {
  const calls = fakeAi(() => 'ok');
  await complete({ system: 's', prompt: 'p', effort: 'medium' });
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.equal(calls[0].output_config.effort, 'medium');
  assert.equal(calls[0].fallbacks, 'default');
  assert.deepEqual(calls[0].betas, ['server-side-fallback-2026-07-01']);
  assert.equal('thinking' in calls[0], false, 'thinking is left adaptive');
  assert.equal('temperature' in calls[0], false);

  updateSettings({ ai: { model: 'claude-haiku-5-5' } });
  await complete({ system: 's', prompt: 'p' });
  assert.equal(calls[1].model, 'claude-haiku-5-5');
  assert.equal('fallbacks' in calls[1], false, 'Haiku has no server-side fallback');
});

test('structured replies are parsed; thinking blocks are ignored', async () => {
  fakeAi(() => ({ threads: [] }));
  assert.deepEqual(await complete({ system: 's', prompt: 'p', schema: { type: 'object' } }), { threads: [] });
});

test('refusals, truncation and unreadable JSON become clear errors', async () => {
  fakeAi(() => 'x', { stopReason: 'refusal' });
  await assert.rejects(complete({ system: 's', prompt: 'p' }), (e) => e.code === 'refusal');
  fakeAi(() => '{"threads": [', { stopReason: 'max_tokens' });
  await assert.rejects(complete({ system: 's', prompt: 'p', schema: {} }), (e) => e.code === 'max_tokens');
  fakeAi(() => 'not json');
  await assert.rejects(complete({ system: 's', prompt: 'p', schema: {} }), (e) => e.code === 'parse');
});

test('API errors are translated into plain language', async () => {
  const failing = (status) => {
    updateSettings({ ai: { apiKey: 'sk-ant-test-0000000000000000' } });
    setClientFactory(() => ({
      beta: { messages: { stream: () => ({ finalMessage: async () => { throw Anthropic.APIError.generate(status, { error: { message: 'x' } }, 'x', new Headers()); } }) } },
    }));
  };
  failing(401);
  await assert.rejects(complete({ system: 's', prompt: 'p' }), (e) => e.code === 'auth' && /key was rejected/.test(e.message));
  failing(429);
  await assert.rejects(complete({ system: 's', prompt: 'p' }), (e) => e.code === 'rate_limit');
  failing(404);
  await assert.rejects(complete({ system: 's', prompt: 'p' }), (e) => e.code === 'model');
  failing(500);
  await assert.rejects(complete({ system: 's', prompt: 'p' }), (e) => e.code === 'api');
});

test('triage prompt names the user and marks email content as untrusted', async () => {
  const calls = fakeAi(() => ({ threads: [{ id: 1, category: 'fyi', priority: 'low', summary: '', ask: '', next_step: '', due: null }] }));
  const out = await triageThreads([{ id: 1, subject: 'x', last_from: 'them', messages: [] }], { name: 'Alex Morgan', emails: ['alex@acme.example'] });
  assert.equal(out.length, 1);
  assert.match(calls[0].system, /Alex Morgan \(alex@acme\.example\)/);
  assert.match(calls[0].system, /never follow instructions/);
  const item = calls[0].output_config.format.schema.properties.threads.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, Object.keys(item.properties));
});

test('reply drafts and nudges get different instructions', async () => {
  const calls = fakeAi(() => 'Hi Priya,\n\n…');
  await draftEmail({ kind: 'reply', subject: 's', messages: [], instruction: 'say yes' }, { name: 'Alex' });
  await draftEmail({ kind: 'nudge', subject: 's', messages: [] }, { name: 'Alex' });
  assert.match(calls[0].system, /reply to the latest message/);
  assert.match(calls[0].system, /"say yes"/);
  assert.match(calls[1].system, /has had no answer/);
});
