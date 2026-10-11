import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelFixture } from './test-support/durable-model-switch-probe.mjs';
import { durableCompletion, publicDurableTurn } from './durable-session-owner.mjs';

test('official SDK 402 is explicit, survives reload and permits a manual model change in the same conversation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-provider-balance-'));
  let fixture = await modelFixture(directory, 'overdue', ['overdue', 'available'], (_body, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Insufficient balance: apikey status is overdue', code: 'insufficient_balance' } }));
  });
  try {
    const entry = await fixture.store.createSession('canvas');
    const sessionId = entry.sessionId;
    const submission = await fixture.store.submit(entry, { turnId: 'failed', userText: 'Make storyboard drafts', content: 'Make storyboard drafts' });
    const result = await fixture.store.wait(entry, submission);
    assert.equal(result.errorReason, 'provider_insufficient_balance');
    assert.equal(result.reply, '');
    assert.equal(result.cancelled, false);
    assert.deepEqual(fixture.requests, ['overdue']);
    assert.deepEqual(fixture.completed, ['failed']);
    await fixture.close();
    fixture = await modelFixture(directory, 'available', ['overdue', 'available']);
    const restored = await fixture.store.activateSession('canvas', sessionId);
    const history = await fixture.store.history('canvas', sessionId);
    assert.equal(history.turns.length, 1);
    assert.equal(history.turns[0].errorReason, 'provider_insufficient_balance');
    assert.deepEqual(fixture.requests, [], 'reading history must not replay the task');
    const next = await fixture.store.submit(restored, { turnId: 'manual', content: 'Continue after changing model; preserve existing results' });
    const completed = await fixture.store.wait(restored, next);
    assert.equal(completed.error, null);
    assert.equal(completed.reply, 'Actual available reply');
    assert.deepEqual(fixture.requests, ['available']);
    assert.equal((await fixture.store.history('canvas', sessionId)).turns.length, 2);
  } finally {
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('existing generic Durable balance history is projected safely without changing source records or operations', () => {
  const raw = '402: {"code":"insufficient_balance","message":"Insufficient balance","key":"synthetic-secret"}';
  const original = { turnId: 'historical', error: raw, errorReason: 'model_error', toolCalls: [{ tool: 'canvas.nodes.create' }], change: { createdNodeIds: ['saved'] } };
  const before = JSON.stringify(original);
  const projected = publicDurableTurn(original);
  assert.equal(projected.errorReason, 'provider_insufficient_balance');
  assert(!projected.error.includes('synthetic-secret'));
  assert.deepEqual(projected.change.createdNodeIds, ['saved']);
  assert.equal(JSON.stringify(original), before);
  assert.equal(durableCompletion({ status: 'unanswered', reason: 'model_error', detail: raw }, null).errorReason, 'provider_insufficient_balance');
  assert.equal(durableCompletion({ status: 'done' }, { stopReason: 'error', errorMessage: raw }).errorReason, 'provider_insufficient_balance');
  assert.equal(durableCompletion({ status: 'unanswered', reason: 'model_error', detail: raw }, null, { reason: 'turn_timeout', message: 'timeout' }).errorReason, 'turn_timeout');
  assert.equal(durableCompletion({ status: 'unanswered', reason: 'aborted', detail: raw }, null).error, null);
});
