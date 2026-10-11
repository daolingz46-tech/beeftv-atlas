// SDK provider errors can contain credentials or request details. Project only
// stable reasons and fixed text; keep the official journal as the source record.
const messages = {
  provider_insufficient_balance: '模型渠道余额或试用额度不足，请补充额度或更换渠道后再发送。',
  provider_auth_failed: '模型渠道的 API Key 无效或已过期，请更新密钥或更换渠道后再发送。',
  provider_access_denied: '模型渠道拒绝访问，请检查密钥权限或模型开通状态，也可以更换渠道。',
  provider_invalid_request: '模型渠道拒绝了请求参数，请检查模型与协议设置或更换模型后再发送。',
  provider_model_not_found: '模型渠道找不到当前模型或接口，请检查模型名称与接口地址或更换模型。',
  provider_rate_limited: '模型渠道请求过于频繁，请稍后再继续。',
  provider_unavailable: '模型渠道服务暂时不可用，请稍后再继续或更换渠道。',
};
const modelReasons = new Set(['model_error', 'provider_error', 'model_request_failed']);

export function providerFailure(error, reason) {
  if (Object.hasOwn(messages, reason)) return { error: messages[reason], errorReason: reason };
  if (!error || !modelReasons.has(reason)) return { error, errorReason: reason };
  const text = String(error);
  const status = Number(text.match(/^(?:Error:\s*)?(\d{3})\s*:/)?.[1]);
  let detail;
  try { detail = JSON.parse(text.slice(text.indexOf('{'))); } catch { /* SDK errors may be plain text. */ }
  const code = detail?.error?.code || detail?.code;
  let classified;
  if (status === 402 || code === 'insufficient_balance' || code === 'insufficient_quota') classified = 'provider_insufficient_balance';
  else if (status === 401) classified = 'provider_auth_failed';
  else if (status === 403) classified = 'provider_access_denied';
  else if (status === 400 || status === 422) classified = 'provider_invalid_request';
  else if (status === 404) classified = 'provider_model_not_found';
  else if (status === 429) classified = 'provider_rate_limited';
  else if (status >= 500 && status <= 599) classified = 'provider_unavailable';
  return classified ? { error: messages[classified], errorReason: classified } : { error, errorReason: reason };
}
