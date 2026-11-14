// Export the validated SDK graph as an importable n8n JSON file without requiring the SDK at install time.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
const definitions = [], connections = {};
const record = definition => { definitions.push(definition); return definition; };
let last;
const builder = {
  add(item) { last = item; return this; },
  to(item) { connections[last.config.name] = { main: [[{ node: item.config.name, type: 'main', index: 0 }]] }; last = item; return this; },
  group() { return this; }
};
const context = vm.createContext({
  node: record, trigger: record,
  sticky(content, members, config) { return record({ type: 'n8n-nodes-base.stickyNote', version: 1, config: { name: 'Setup instructions', position: config.position, parameters: { content, height: 220, width: 700 } } }); },
  expr: value => '=' + value,
  newCredential: name => ({ name }),
  workflow: () => builder
});
const source = await readFile(new URL('./workflow.sdk.js', import.meta.url), 'utf8');
vm.runInContext(source.replace('export default', 'globalThis.result ='), context, { timeout: 1000 });
const nodes = definitions.map(item => ({
  id: randomUUID(), name: item.config.name, type: item.type, typeVersion: item.version,
  position: item.config.position, parameters: item.config.parameters,
  ...(item.type === 'n8n-nodes-base.webhook' ? { webhookId: randomUUID() } : {})
}));
await writeFile(new URL('./n8n-workflow.json', import.meta.url), JSON.stringify({
  name: 'Udemy SRT — n8n + server Gemini Argon Medium', active: false, nodes, connections,
  settings: { executionOrder: 'v1', saveExecutionProgress: false, saveManualExecutions: false, saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none' },
  meta: { templateCredsSetupCompleted: false }
}, null, 2) + '\n');
console.log('Wrote server/n8n-workflow.json. Assign the two named credentials after import.');
