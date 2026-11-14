const status = document.querySelector('#status');
const keyList = document.querySelector('#keys');
const modelSelect = document.querySelector('#model');
const customModel = document.querySelector('#custom-model');
const addKeyButton = document.querySelector('#add-key');
const modelFallback = document.querySelector('#model-fallback');
const fallbackSelects = [document.querySelector('#fallback-1'), document.querySelector('#fallback-2')];
let modelWrites = Promise.resolve();
function updateKeyLabels() {
  Array.from(keyList.children).forEach((row, index) => {
    row.querySelector('span').textContent = 'Key ' + (index + 1);
    row.querySelector('input').setAttribute('aria-label', 'Gemini API key ' + (index + 1));
    row.querySelector('button').setAttribute('aria-label', 'Remove key ' + (index + 1));
  });
  addKeyButton.disabled = keyList.children.length >= 8;
}
function addKey(value = '') {
  if (keyList.children.length >= 8) return;
  const row = document.createElement('div'); row.className = 'key-row';
  const label = document.createElement('label'); label.append(document.createElement('span'));
  const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'off'; input.value = value; input.placeholder = 'Enter API key';
  label.append(input);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Remove';
  remove.addEventListener('click', () => { row.remove(); updateKeyLabels(); });
  row.append(label, remove); keyList.append(row); updateKeyLabels();
}
function selectedModel() { return modelSelect.value === 'custom' ? customModel.value.trim() : modelSelect.value; }
function updateCustomModel() {
  const custom = modelSelect.value === 'custom';
  customModel.hidden = !custom; customModel.required = custom;
  document.querySelector('#custom-label').hidden = !custom;
}
function addModel(id, label) {
  for (const select of [modelSelect, ...fallbackSelects]) {
    if (Array.from(select.options).some(option => option.value === id)) continue;
    const option = document.createElement('option'); option.value = id; option.textContent = label;
    select.insertBefore(option, select.querySelector('[value="custom"]'));
  }
}
function modelSettings() {
  const settings = { model: selectedModel(), autoModelFallback: modelFallback.checked, fallbackModels: fallbackSelects.map(select => select.value).filter(Boolean) };
  if (!settings.model) throw new Error('Enter a valid model ID.');
  SubtitleCore.modelPolicy(settings);
  return settings;
}
async function notifyLecture() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'MODEL_CHANGED' });
  } catch { /* The next lecture will read the saved model settings. */ }
}
function persistModelSelection() {
  let settings;
  try { settings = modelSettings(); } catch (error) { status.textContent = error.message; return; }
  modelWrites = modelWrites.catch(() => {}).then(async () => {
    await chrome.storage.local.set(settings);
    status.textContent = 'Model saved: ' + settings.model + '. Subtitles will use this selection.';
    await notifyLecture();
  });
  modelWrites.catch(() => { status.textContent = 'Could not save the model. Try again.'; });
  return modelWrites;
}
async function updateProviderStatus() {
  const { lastGeminiRequest } = await chrome.storage.local.get('lastGeminiRequest');
  document.querySelector('#provider-status').textContent = lastGeminiRequest ? 'Last API request: key ' + (lastGeminiRequest.keyIndex + 1) + ' of ' + lastGeminiRequest.keyCount + ' · ' + (lastGeminiRequest.model === '__models__' ? 'model list' : lastGeminiRequest.model) : 'No API request yet.';
}
async function load() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const settings = await chrome.storage.local.get(['apiKeys', 'apiKey', 'model', 'autoRotate', 'availableModels', 'autoModelFallback', 'fallbackModels']);
  const keys = Array.isArray(settings.apiKeys) ? settings.apiKeys : settings.apiKey ? [settings.apiKey] : [''];
  keys.slice(0, 8).forEach(addKey);
  if (!keyList.children.length) addKey();
  for (const model of settings.availableModels || []) addModel(model.id, model.label);
  const selected = settings.model || 'gemini-3.5-flash-lite';
  addModel(selected, selected + ' (saved)'); modelSelect.value = selected;
  const fallbacks = Array.isArray(settings.fallbackModels) ? settings.fallbackModels : ['gemini-3.1-flash-lite', 'gemini-flash-lite-latest'];
  fallbacks.slice(0, 2).forEach((model, i) => { addModel(model, model); fallbackSelects[i].value = model; });
  modelFallback.checked = settings.autoModelFallback !== false;
  for (const control of [modelSelect, modelFallback, ...fallbackSelects]) control.disabled = false;
  document.querySelector('#rotate').checked = settings.autoRotate !== false;
  updateCustomModel(); await updateProviderStatus();
}
addKeyButton.addEventListener('click', () => { addKey(); keyList.lastElementChild?.querySelector('input')?.focus(); });
modelSelect.addEventListener('change', () => { updateCustomModel(); if (modelSelect.value !== 'custom') persistModelSelection(); });
customModel.addEventListener('change', persistModelSelection);
modelFallback.addEventListener('change', persistModelSelection);
fallbackSelects.forEach(select => select.addEventListener('change', persistModelSelection));
document.querySelector('#settings').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const apiKeys = [...new Set(Array.from(keyList.querySelectorAll('input')).map(input => input.value.trim()).filter(Boolean))];
    const config = modelSettings();
    await modelWrites.catch(() => {});
    await chrome.storage.local.set({ apiKeys, ...config, autoRotate: document.querySelector('#rotate').checked });
    await chrome.storage.local.remove('apiKey');
    status.textContent = 'Settings saved. ' + apiKeys.length + ' key(s) configured. Preferred model: ' + config.model + '.';
    await notifyLecture();
  } catch (error) { status.textContent = error.message || 'Could not save settings.'; }
});
document.querySelector('#refresh-models').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true; status.textContent = 'Loading available models…';
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'LIST_MODELS' });
    if (!reply?.ok) throw new Error(reply?.error || 'Could not load models.');
    // Read the current selection after the request: the user may have changed it while loading.
    const current = selectedModel();
    for (const model of reply.models) addModel(model.id, model.label + ' (' + model.id + ')');
    await chrome.storage.local.set({ availableModels: reply.models });
    if (current) { addModel(current, current + ' (saved)'); modelSelect.value = current; }
    updateCustomModel(); await updateProviderStatus();
    status.textContent = reply.models.length + ' text models loaded. Model selections save automatically.';
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#open').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_PANEL' }); window.close();
  } catch { status.textContent = 'Open a Udemy lecture and reload the page.'; }
});
document.querySelector('#clear').addEventListener('click', async () => {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(key => key.startsWith('translation:'));
    await chrome.storage.local.remove(keys);
    status.textContent = 'Cleared ' + keys.length + ' cached batches. Reload the lecture.';
  } catch { status.textContent = 'Could not clear the cache.'; }
});
load().catch(() => { status.textContent = 'Could not load settings. Reopen the extension.'; });
