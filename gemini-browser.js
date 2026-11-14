((transport) => {
  // The worker binds one dedicated Gemini tab to one Udemy job. Other Gemini chats stay untouched.
  let busy = false, stopped = false, lastRaw = '', stableSince = 0, idleCount = 0, wakePending = false, pollTimer;
  function startPolling() { if (!pollTimer) pollTimer = setInterval(tick, 1500); }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; lastRaw = ''; }
  const notice = document.createElement('div');
  notice.style.cssText = 'position:fixed;bottom:12px;left:12px;max-width:420px;z-index:2147483647;background:#132438;color:#fff;border:1px solid #90b7da;padding:12px;border-radius:8px;font:14px/1.7 "Myanmar Text",sans-serif;white-space:pre-line';
  const send = async message => {
    const result = await transport(message);
    if (!result?.ok) throw new Error(result?.error || 'Extension connection lost.');
    return result;
  };
  function display(text) { notice.textContent = text; if (!notice.isConnected) document.documentElement.append(notice); }
  const visible = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  function editor() { return Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).find(visible); }
  function buttons() { return Array.from(document.querySelectorAll('button')).filter(visible); }
  function generating() { return buttons().some(e => /stop response|stop generating/i.test(e.getAttribute('aria-label') || '') || e.classList.contains('stop-button')); }
  function submit() { return buttons().find(e => /^(send message|send|submit)$/i.test(e.getAttribute('aria-label') || '') || e.classList.contains('send-button')); }
  async function waitFor(find, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && !stopped) { const value = find(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 400)); }
    throw new Error('Gemini page controls are unavailable. Sign in, select Pro, then retry from Udemy.');
  }
  async function upload(task) {
    let box = editor();
    if (!box) { display('Gemini မှာ login ဝင်ပါ။ စာရေးကွက်ပေါ်လာလျှင် ဆက်လုပ်ပါမည်။'); return; }
    const accounts = await waitFor(() => {
      const nodes = Array.from(document.querySelectorAll('a[aria-label*="Google Account:"],button[aria-label*="Google Account:"]'));
      return nodes.length && nodes;
    });
    if (!accounts.some(e => (e.getAttribute('aria-label') || '').toLowerCase().includes(`(${task.expectedEmail})`))) throw new Error('This is not the configured Pro account. No subtitle file was uploaded. Check the account number and email in extension settings.');
    // Gemini briefly restores its editor while loading a saved chat. Never erase a draft or mistake hydration for a user draft.
    const editorDeadline = Date.now() + 15000;
    while ((!box || box.textContent.trim() || generating()) && Date.now() < editorDeadline) {
      await new Promise(resolve => setTimeout(resolve, 400)); box = editor();
    }
    if (!box || box.textContent.trim() || generating()) {
      const current = await send({ type: 'WEB_TASK' });
      if (current.id !== task.id || current.state !== 'ready') return;
      throw new Error('The dedicated Gemini tab already contains a draft or active response. Finish or clear it, then retry from Udemy.');
    }
    await selectModel(task.browserModel || 'argon-medium');
    const findInput = () => Array.from(document.querySelectorAll('input[type="file"]')).find(e => (e.accept || '').includes('.srt'));
    let input = findInput();
    if (!input) {
      const tools = buttons().find(e => /upload.*tools/i.test(e.getAttribute('aria-label') || ''));
      if (tools) tools.click();
      input = await waitFor(findInput, 10000);
    }
    // Mark before upload/send: a reload must never silently send the same lecture twice.
    const claim = await send({ type: 'WEB_SENT', id: task.id });
    if (!claim.claimed) return;
    display('ဗီဒီယိုတစ်ခုလုံး၏ SRT ဖိုင်ကို တင်နေပါသည်။\nဒီ tab ကို မပိတ်ပါနှင့်။');
    const transfer = new DataTransfer();
    transfer.items.add(new File([task.srt], `udemy-${task.id}.srt`, { type: 'text/plain' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    box.focus();
    if (!document.execCommand('insertText', false, task.prompt)) {
      box.textContent = task.prompt;
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: task.prompt }));
    }
    // Let the editor and attachment upload settle before checking the enabled Send control.
    await new Promise(resolve => setTimeout(resolve, 1500));
    const button = await waitFor(() => {
      const b = submit();
      const attachment = document.body.textContent.includes(`udemy-${task.id}.srt`);
      const loading = Array.from(document.querySelectorAll('[role="progressbar"],.upload-progress')).some(visible);
      return attachment && !loading && b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b;
    }, 90000);
    const current = await send({ type: 'WEB_TASK' });
    if (current.id !== task.id || current.state !== 'waiting') return;
    button.click();
    display('SRT ဖိုင်တစ်ခုလုံးကို ဘာသာပြန်နေပါသည်။\nအဖြေအကုန်ရလျှင် Udemy သို့ အလိုအလျောက် ပြန်ပို့ပါမည်။');
  }
  async function selectModel(model) {
    if (model === 'current') return;
    if (!['hydrogen-medium', 'argon-medium', 'flash-lite'].includes(model)) throw new Error('Unknown Gemini browser model.');
    const picker = () => buttons().find(e => /open mode picker/i.test(e.getAttribute('aria-label') || ''));
    const selected = () => (model === 'flash-lite' ? /currently (?:3\.5 )?Flash[\s-]?Lite$/i : (model === 'hydrogen-medium' ? /currently (?:[\d.]+ )?Hydrogen Medium$/i : /currently (?:4 )?Argon Medium$/i)).test(picker()?.getAttribute('aria-label') || '');
    if (selected()) return;
    const mode = await waitFor(picker);
    mode.click();
    const choices = role => Array.from(document.querySelectorAll(`[role="${role}"]`)).filter(visible);
    const choice = await waitFor(() => {
      const options = choices('menuitemradio');
      const match = options.find(e => (model === 'flash-lite' ? /\bFlash[\s-]?Lite\b/i : (model === 'hydrogen-medium' ? /\bHydrogen\b/i : /\bArgon\b/i)).test(e.textContent));
      if (options.length && !match) throw new Error('ရွေးထားသည့် model ကို Gemini menu မှာ မရနိုင်ပါ။ Limit အခြေအနေ စစ်ပါ။ Udemy မှာ model ပြောင်းပါ၊ သို့မဟုတ် Gemini မှာ ကိုယ်တိုင်ရွေးသည့်နည်း သုံးပါ။');
      return match;
    });
    if (choice.getAttribute('aria-disabled') === 'true' || choice.disabled) throw new Error('ရွေးထားသည့် model သည် limit ပြည့်နေပါသည်။ Udemy မှာ Gemini browser model ကို ပြောင်းပြီး Translate ပြန်နှိပ်ပါ။');
    choice.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    if (selected()) return;
    if (model === 'flash-lite') { await waitFor(selected); return; }
    picker()?.click();
    const thinking = await waitFor(() => choices('menuitem').find(e => /thinking level/i.test(e.textContent)));
    thinking.click();
    const medium = await waitFor(() => choices('menuitemradio').find(e => /^\s*Medium\b/i.test(e.textContent)));
    if (medium.getAttribute('aria-disabled') === 'true' || medium.disabled) throw new Error('ရွေးထားသည့် Medium model limit ပြည့်နေပါသည်။ Udemy မှာ Flash-Lite သို့မဟုတ် Gemini မှာ ရွေးထားသည့် model ကို ပြောင်းပြီး Translate ပြန်နှိပ်ပါ။');
    medium.click();
    await waitFor(selected);
  }
  async function repair(task) {
    const box = await waitFor(editor);
    if (box.textContent.trim() || generating()) throw new Error('Gemini chat ထဲတွင် draft သို့မဟုတ် အဖြေတစ်ခု ရှိနေပါသည်။ အရင်ရှင်းပြီး Udemy မှ ပြန်စပါ။');
    const claim = await send({ type: 'WEB_REPAIR_SENT', id: task.id });
    if (!claim.claimed) return;
    box.focus();
    if (!document.execCommand('insertText', false, task.repairPrompt)) {
      box.textContent = task.repairPrompt;
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: task.repairPrompt }));
    }
    const button = await waitFor(() => { const b = submit(); return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b; });
    const current = await send({ type: 'WEB_TASK' });
    if (current.id !== task.id || current.state !== 'waiting') return;
    button.click(); lastRaw = ''; stableSince = 0;
    display('စာကြောင်းအရေအတွက် မကိုက်သဖြင့် မူရင်း ID များဖြင့် ပြန်ဘာသာပြန်နေပါသည်။\nအကုန်ပြည့်မှ Udemy တွင် စာတန်းပြပါမည်။');
  }
  function responseText(id) {
    // Only model responses; never accept the prompt, sidebar, or unrelated chat text.
    const nodes = Array.from(document.querySelectorAll('model-response .markdown, model-response message-content, .model-response-text'));
    // Only the latest response can belong to the current job. Avoid materializing old chat history.
    for (const node of nodes.slice(-1)) {
      const text = node.innerText || node.textContent || '';
      if (!text.includes(`BEGIN_${id}`) || !text.includes(`END_${id}`)) continue;
      // Rendered code blocks include language labels and Copy buttons. Read only the code, keeping job markers.
      const code = Array.from(node.querySelectorAll('pre code'));
      if (code.length === 1) {
        const content = code[0].textContent;
        const begin = `BEGIN_${id}`, end = `END_${id}`;
        if (content.includes(begin) || /^\s*\[/.test(content) || /\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(content)) {
          // Gemini may put either marker inside the code block or outside it.
          return (content.includes(begin) ? '' : begin + '\n') + content + (content.includes(end) ? '' : '\n' + end);
        }
      }
      return text;
    }
    return '';
  }
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    let task;
    try {
      task = await send({ type: 'WEB_TASK' });
      if (task.idle) { if (notice.isConnected) { display('ဒီဘာသာပြန်လုပ်ငန်းကို ရပ်ထားပါသည်။'); stopped = true; } else if (++idleCount > 5 || !location.hash.includes('udemy-srt=')) stopped = true; return; }
      if (['done', 'cancelled', 'error'].includes(task.state)) {
        stopped = true;
        display(task.state === 'done' ? 'ဘာသာပြန်ပြီးပါပြီ။ Udemy မှာ စာတန်းထိုး အသင့်ဖြစ်ပါပြီ။' : task.state === 'cancelled' ? 'ဘာသာပြန်မှုကို ရပ်ထားပါသည်။' : task.error);
        return;
      }
      if (task.state === 'ready') await upload(task);
      if (task.state === 'repair-ready') await repair(task);
      if (task.state === 'waiting') {
        const raw = responseText(task.responseId || task.id);
        if (!raw || generating()) { lastRaw = ''; stableSince = 0; return; }
        if (raw !== lastRaw) { lastRaw = raw; stableSince = Date.now(); return; }
        if (Date.now() - stableSince >= 3000) {
          const result = await send({ type: 'WEB_RESULT', id: task.id, raw });
          if (result.repair) { lastRaw = ''; stableSince = 0; display('စာကြောင်းမပြည့်သဖြင့် အလိုအလျောက် ပြန်တောင်းနေပါသည်။'); return; }
          if (!result.done) { lastRaw = ''; stableSince = 0; return; }
          display('ဘာသာပြန်ပြီးပါပြီ။ Udemy မှာ စာတန်းထိုး အသင့်ဖြစ်ပါပြီ။'); stopped = true;
        }
      }
    } catch (error) {
      display(error.message);
      if (task?.id) { try { await send({ type: 'WEB_ERROR', id: task.id, error: error.message }); } catch {} }
      stopped = true;
    } finally {
      busy = false;
      if (wakePending) { wakePending = false; stopped = false; startPolling(); tick(); }
      else if (stopped) stopPolling();
    }
  }
  // Idle between jobs without polling the worker. A new lecture wakes this same chat adapter.
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) chrome.runtime.onMessage?.addListener((message, sender, respond) => {
    if (message?.type !== 'BROWSER_JOB_AVAILABLE') return false;
    stopped = false; lastRaw = ''; stableSince = 0; idleCount = 0;
    startPolling();
    if (busy) wakePending = true; else tick(); respond?.({ ok: true }); return false;
  });
  startPolling();
  tick();
})(typeof chrome !== 'undefined' && chrome.runtime?.id ? message => chrome.runtime.sendMessage(message) : globalThis.__udemySubtitleTransport);
