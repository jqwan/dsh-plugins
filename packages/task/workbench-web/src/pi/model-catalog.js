/** Read pi model configuration without allocating a conversation or starting an agent. */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findPackageJSON } from 'node:module';
import { resolvePiCliEntry } from './tui-executor.js';

export async function piModelCatalog(cwd) {
  const cli = resolvePiCliEntry();
  if (!cli) throw new Error('未找到 pi');
  const entry = realpathSync(cli);
  const sdk = await import(pathToFileURL(join(dirname(entry), 'index.js')).href);
  const aiPackagePath = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(entry));
  if (!aiPackagePath) throw new Error('未找到 pi 模型能力模块');
  const aiPackage = JSON.parse(readFileSync(aiPackagePath, 'utf8'));
  const compatExport = aiPackage.exports?.['./compat']?.import;
  if (typeof compatExport !== 'string') throw new Error('pi 模型能力模块未提供 ESM compat 导出');
  const { getSupportedThinkingLevels } = await import(new URL(compatExport, pathToFileURL(aiPackagePath)).href);
  const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
  if (runtime.getError()) throw new Error(runtime.getError());
  const settings = sdk.SettingsManager.create(cwd);
  const models = runtime.getAvailableSnapshot().map(model => ({ id: model.id, name: model.name, provider: model.provider, reasoning: model.reasoning, levels: getSupportedThinkingLevels(model) }));
  return { models, current: { provider: settings.getDefaultProvider(), model: settings.getDefaultModel(), reasoningEffort: settings.getDefaultThinkingLevel() } };
}

/** Validate a draft selection against the same pi catalog used by its menu. */
export async function resolvePiDraftModel(selection, cwd) {
  if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') throw new Error('模型参数无效');
  const { models } = await piModelCatalog(cwd);
  const model = models.find(model => model.provider === selection.provider && model.id === selection.model);
  if (!model) throw new Error('所选 pi 模型不可用');
  if (selection.reasoningEffort !== undefined && !model.levels.includes(selection.reasoningEffort)) throw new Error('所选思考等级不可用');
  return { provider: model.provider, model: model.id, ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}) };
}
