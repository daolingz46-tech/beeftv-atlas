import { expect, test } from 'bun:test';
import { providerFailure } from './provider-failure.mjs';
import { modelTurnCompletion, projectTurnHistory } from './canvas-turn.mjs';

const overdue = '402: {"message":"Insufficient balance: apikey status is overdue","type":"insufficient_balance","code":"insufficient_balance","api_key":"synthetic-secret"}';
test('SDK balance errors have a stable safe reason in live and legacy history projections', () => {
  for (const reason of ['model_error', 'provider_error', 'model_request_failed']) {
    const failure = providerFailure(overdue, reason);
    expect(failure.errorReason).toBe('provider_insufficient_balance');
    expect(failure.error).toContain('余额');
    expect(failure.error).not.toContain('synthetic-secret');
  }
  expect(modelTurnCompletion(null, 'Error: ' + overdue).errorReason).toBe('provider_insufficient_balance');
  const entries = [{ type: 'custom', customType: 'turn', data: { turnId: 'first', error: overdue, errorReason: 'model_request_failed', change: { createdNodeIds: ['saved'] } } }];
  const before = JSON.stringify(entries);
  const [projected] = projectTurnHistory(entries, 'turn');
  expect(projected.errorReason).toBe('provider_insufficient_balance');
  expect(projected.change.createdNodeIds).toEqual(['saved']);
  expect(JSON.stringify(entries)).toBe(before);
});
test('configuration errors differ from transient failures without overriding budgets or cancellation', () => {
  for (const [status, reason] of [[401, 'provider_auth_failed'], [403, 'provider_access_denied'], [400, 'provider_invalid_request'], [422, 'provider_invalid_request'], [404, 'provider_model_not_found'], [429, 'provider_rate_limited'], [503, 'provider_unavailable']]) {
    expect(providerFailure(`${status}: synthetic-private-details`, 'model_error').errorReason).toBe(reason);
    expect(providerFailure(`${status}: synthetic-private-details`, 'model_error').error).not.toContain('synthetic-private-details');
  }
  expect(providerFailure('429: {"error":{"code":"insufficient_quota"}}', 'model_error').errorReason).toBe('provider_insufficient_balance');
  expect(providerFailure(overdue, 'turn_request_budget_exhausted').errorReason).toBe('turn_request_budget_exhausted');
  expect(providerFailure('unknown provider failure', 'model_error').errorReason).toBe('model_error');
  expect(providerFailure(overdue, 'constructor').error).toBe(overdue);
  expect(modelTurnCompletion(null, overdue, null, { cancelled: true }).error).toBeNull();
});
