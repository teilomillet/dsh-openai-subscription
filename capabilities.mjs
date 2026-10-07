// Public model capabilities, verified against official model pages on 2026-10-07.
// This table describes request options, never an account's model entitlement.
const five = ['low', 'medium', 'high', 'xhigh', 'max'];
const six = ['none', ...five];
const rows = [
  ['gpt-6.1-sol', 'GPT-6.1 Sol', five],
  ['gpt-6-astra', 'GPT-6 Astra', five],
  ['gpt-5.6-sol', 'GPT-5.6 Sol', six],
  ['gpt-5.6-terra', 'GPT-5.6 Terra', six],
  ['gpt-5.6-luna', 'GPT-5.6 Luna', six],
];
export const documentedCapabilities = Object.freeze(Object.fromEntries(rows.map(([slug, displayName, reasoningEfforts]) => [slug, Object.freeze({
  slug, displayName, reasoningEfforts: Object.freeze([...reasoningEfforts]),
  source: `https://developers.openai.com/api/docs/models/${slug}`, checkedAt: '2026-10-07',
})])));

export function enrichDocumentedCapabilities(models) {
  return models.map(model => {
    const capability = documentedCapabilities[model.slug];
    return capability ? { ...model, reasoningEfforts: [...capability.reasoningEfforts], reasoningEffortsSource: capability.source } : { ...model };
  });
}
