((transport) => {
  // The worker binds one dedicated Gemini tab to one Udemy job. Other Gemini chats stay untouched.
  let busy = false, stopped = false, lastRaw = '', stableSince = 0, idleCount = 0, wakePending = false, pollTimer;
  let missingKey = '', missingSince = 0;
  let busyStatusKey = '';
  let reportedAccount = '';
  let accountWaitSince = Date.now();
  let lastErrorText = '', errorSince = 0, localRetry = { id: '', count: 0, at: 0 };
  const clientId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  function startPolling() { if (!pollTimer) pollTimer = setInterval(tick, 1500); }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; lastRaw = ''; }
  const notice = document.createElement('div');
  notice.style.cssText = 'position:fixed;bottom:12px;right:12px;max-width:min(420px,calc(100vw - 48px));pointer-events:none;z-index:2147483647;background:#132438;color:#fff;border:1px solid #90b7da;padding:12px;border-radius:8px;font:14px/1.7 "Myanmar Text",sans-serif;white-space:pre-line';
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
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  function quotaError() {
    const banner = Array.from(document.querySelectorAll('.inline-upgrade-banner-text')).find(e => visible(e) && /^Limit reached\b/i.test(normalize(e.textContent)));
    if (!banner) return '';
    const reset = normalize(banner.textContent).match(/Resets at\s+([\d:]+\s*(?:AM|PM)?)/i)?.[1]?.trim();
    return `Gemini limit ပြည့်နေပါသည်။${reset ? ` ပြန်သုံးနိုင်မည့်အချိန် ${reset}။` : ''} Model ပြောင်းပြီး Translate ပြန်နှိပ်ပါ၊ သို့မဟုတ် limit ပြန်ဖွင့်ချိန်အထိ စောင့်ပါ။`;
  }
  const draftText = box => box?.innerText ?? box?.textContent ?? '';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  function latestQuery() { const nodes = document.querySelectorAll('user-query'); return nodes[nodes.length - 1]; }
  function queryMatches(id) { const query = latestQuery(); const text = query?.innerText || query?.textContent || ''; return text.includes(`BEGIN_${id}`) && text.includes(`END_${id}`); }
  function composer() { const box = editor(); return box?.closest?.('input-area-v2') || box?.closest?.('.input-area') || document.body; }
  function missingConversation(task) {
    if (!task.conversationUrl || !/\/app\/[^/]+$/.test(task.conversationUrl) || !location.href || generating()) return null;
    const current = location.href.split(/[?#]/)[0];
    const base = `https://gemini.google.com/u/${task.accountIndex}/app`;
    if (current !== task.conversationUrl && !(task.chatProbe && current === base)) return 'changed';
    const box = editor();
    if (normalize(draftText(box)) || document.querySelectorAll('user-query').length) return null;
    if (!box || Array.from(document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')).some(visible)) return task.chatProbe && current === base ? 'loading' : null;
    const fresh = Array.from(document.querySelectorAll('h1')).some(e => visible(e) && /^Where should we start\?$/i.test(normalize(e.textContent)));
    if (task.chatProbe && current === base) return fresh ? 'redirected-empty' : 'loading';
    const missing = Array.from(document.querySelectorAll('[role="alert"],h1,h2')).some(e => visible(e) && /^(?:This chat (?:does not exist|is (?:no longer available|not available)|was deleted)|(?:Couldn.t|Unable to|Cannot) (?:load|find) (?:this |the )?(?:chat|conversation))[.!]?$/i.test(normalize(e.textContent)));
    return current === task.conversationUrl && missing ? 'not-found' : null;
  }
  async function recoverMissingChat(task) {
    const reason = missingConversation(task);
    if (!reason) { missingKey = ''; return false; }
    if (reason === 'changed') throw new Error('သတ်မှတ်ထားသော Gemini chat ပြောင်းသွားပါသည်။ အခြား chat သို့ မပို့ဘဲ ရပ်ထားပါသည်။');
    if (reason === 'loading') { missingKey = ''; display('Gemini စာမျက်နှာ အသင့်ဖြစ်သည်အထိ စောင့်နေပါသည်။'); return true; }
    await verifyAccount(task);
    const key = task.id + task.conversationUrl + reason;
    if (missingKey !== key) { missingKey = key; missingSince = Date.now(); display('မူလ Gemini chat ရှိမရှိ အတည်ပြုနေပါသည်။'); return true; }
    if (Date.now() - missingSince < 3000) return true;
    const result = await send({ type: 'WEB_CHAT_MISSING', id: task.id, conversationUrl: task.conversationUrl, reason });
    if (!result.claimed) throw new Error('Gemini chat အခြေအနေ ပြောင်းလဲသွားပါသည်။ မူလ chat ကို မပြောင်းဘဲ ရပ်ထားပါသည်။');
    missingKey = ''; lastRaw = ''; stableSince = 0;
    display('မူလ chat မရှိတော့သဖြင့် chat အသစ်တစ်ခုကိုသာ ဆက်သုံးပြီး ဘာသာပြန်နေပါသည်။');
    return true;
  }
  function fileLabelMatches(label, base) {
    const value = normalize(label).replace(/^(?:close|remove|delete)\s+/i, '').replace(/\.srt$/i, '');
    if (value === base) return true;
    const parts = value.split(/\.\.\.|…/);
    return parts.length === 2 && parts[0].length >= 8 && parts[1].length >= 8 && base.startsWith(parts[0]) && base.endsWith(parts[1]);
  }
  function attachmentPresent(task) {
    const root = composer(), base = `udemy-${task.id}`;
    return (root.textContent || '').includes(base) || Array.from(root.querySelectorAll?.('.gem-attachment-text,[aria-label],[title]') || []).some(e => fileLabelMatches(e.textContent, base) || fileLabelMatches(e.getAttribute('aria-label'), base) || fileLabelMatches(e.getAttribute('title'), base));
  }
  async function verifyAccount(task) {
    const accounts = await waitFor(() => { const nodes = Array.from(document.querySelectorAll('a[aria-label*="Google Account:"],button[aria-label*="Google Account:"]')); return nodes.length && nodes; });
    if (!accounts.some(e => (e.getAttribute('aria-label') || '').toLowerCase().includes(`(${task.expectedEmail})`))) throw new Error('This is not the configured Pro account. No subtitle file was uploaded. Check the account number and email in extension settings.');
  }
  async function draftOwner(task, text) {
    const value = normalize(text);
    if (!value) return null;
    const expected = task.deliveryPrompt || task.prompt || task.repairPrompt;
    if (expected && value === normalize(expected)) return { responseId: task.responseId || task.id, fileBase: `udemy-${task.id}` };
    const candidates = (task.ownedDrafts || []).filter(x => value.includes(`BEGIN_${x.responseId}`) && value.includes(`END_${x.responseId}`));
    if (!candidates.length) return null;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
    return candidates.find(x => x.hash === hash) || null;
  }
  async function clearOwnedDraft(task) {
    const box = editor();
    if (!box || generating()) return false;
    const owner = await draftOwner(task, draftText(box)) || (!normalize(draftText(box)) && (task.ownedDrafts || []).find(x => attachmentPresent({ id: x.fileBase.slice(6) })));
    if (!owner) return false;
    const root = composer();
    for (const button of Array.from(root.querySelectorAll?.('button') || [])) {
      if (!/^(?:close|remove|delete)\b/i.test(button.getAttribute('aria-label') || '')) continue;
      if (fileLabelMatches(button.getAttribute('aria-label'), owner.fileBase)) { button.click(); continue; }
      let container = button;
      for (let depth = 0; container && container !== root && depth < 6; depth++, container = container.parentElement) {
        if ((container.textContent || '').includes(owner.fileBase) && container.querySelectorAll('button').length <= 2) { button.click(); break; }
      }
    }
    box.focus(); document.execCommand('selectAll', false); document.execCommand('delete', false);
    if (draftText(box).trim()) { box.textContent = ''; box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); }
    if (attachmentPresent({ id: owner.fileBase.slice(6) })) throw new Error('ယခင် SRT attachment ကို မရှင်းနိုင်ပါ။ အခြားဖိုင်နှင့် ရောမပို့ပါ။');
    return true;
  }
  async function deliveryClaim(task, stage) {
    const current = await send({ type: 'WEB_TASK' });
    if (current.id !== task.id || current.state !== 'waiting' || (current.responseId || current.id) !== (task.responseId || task.id)) return false;
    if (!task.recovery) return true;
    const result = await send({ type: 'WEB_DELIVERY', id: task.id, responseId: task.responseId || task.id, stage, clientId });
    return result.claimed;
  }
  async function deliver(task, repairOnly = false) {
    const id = task.responseId || task.id, prompt = task.deliveryPrompt || task.repairPrompt || task.prompt;
    if (queryMatches(id)) { await deliveryClaim(task, 'ack'); return; }
    if (quotaError()) throw new Error(quotaError());
    await verifyAccount(task);
    for (let attempt = 0; attempt < 2; attempt++) {
      let box = await waitFor(editor);
      if (draftText(box).trim() && normalize(draftText(box)) !== normalize(prompt)) {
        if (!await clearOwnedDraft(task)) throw new Error('Gemini ထဲတွင် ကိုယ်တိုင်ရေးထားသော draft ရှိနေပါသည်။ မဖျက်ဘဲ ရပ်ထားပါသည်။');
        box = await waitFor(editor);
      }
      if (generating()) throw new Error('Gemini မှာ အခြားအဖြေ ပြင်ဆင်နေပါသည်။ ထပ်မပို့ပါ။');
      if (!repairOnly && !attachmentPresent(task)) {
        if (!await deliveryClaim(task, 'upload')) return;
        const findInput = () => { const local = Array.from(composer().querySelectorAll?.('input[type="file"]') || []); return (local.length ? local : Array.from(document.querySelectorAll('input[type="file"]'))).filter(e => (e.getAttribute('accept') || e.accept || '').includes('.srt')).at(-1); };
        let input = findInput();
        if (!input) { buttons().find(e => /upload.*tools/i.test(e.getAttribute('aria-label') || ''))?.click(); input = await waitFor(findInput, 10000); }
        display('ဗီဒီယိုတစ်ခုလုံး၏ SRT ဖိုင် တင်ပြီးကြောင်း စစ်နေပါသည်။');
        const transfer = new DataTransfer(); transfer.items.add(new File([task.recoverySrt || task.srt], `udemy-${task.id}.srt`, { type: 'text/plain' }));
        input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        try { await waitFor(() => attachmentPresent(task) && !Array.from(composer().querySelectorAll?.('[role="progressbar"],.upload-progress,[aria-busy="true"]') || []).some(visible), 30000); }
        catch (error) { if (attempt === 0) continue; throw error; }
      }
      // Model selection and uploading can replace the editor. Never reuse its old node.
      box = await waitFor(editor);
      if (!draftText(box).trim()) {
        box.focus();
        if (!document.execCommand('insertText', false, prompt)) { box.textContent = prompt; box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt })); }
      }
      if (normalize(draftText(box)) !== normalize(prompt)) throw new Error('Gemini draft ပြောင်းလဲသွားပါသည်။ ကိုယ်တိုင်ရေးထားသည့်စာကို မပို့ပါ။');
      const button = await waitFor(() => { const b = submit(); return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b; });
      if (!await deliveryClaim(task, 'send')) return;
      button.click();
      try { await waitFor(() => queryMatches(id), 15000); await deliveryClaim(task, 'ack'); display('SRT ပို့ပြီးပါပြီ။ ဘာသာပြန်အဖြေ အပြည့်ကို စောင့်နေပါသည်။'); return; }
      catch (error) {
        if (queryMatches(id)) { await deliveryClaim(task, 'ack'); return; }
        if (normalize(draftText(editor())) !== normalize(prompt)) throw new Error('ပို့ပြီးကြောင်း မအတည်ပြုနိုင်ပါ။ နှစ်ခါမပို့ရန် ရပ်ထားပါသည်။');
        if (attempt === 1) throw error;
        display('Gemini က draft ကို မပို့ရသေးပါ။ လက်ရှိ draft ကို တစ်ကြိမ် ပြန်ပို့နေပါသည်။');
      }
    }
  }
  async function upload(task) {
    let box = editor();
    if (!box) { display('Gemini မှာ login ဝင်ပါ။ စာရေးကွက်ပေါ်လာလျှင် ဆက်လုပ်ပါမည်။'); return; }
    await verifyAccount(task);
    if (await recoverMissingChat(task)) return;
    if (generating()) {
      display('Gemini ၏ အရင်အဖြေ ပြီးသည်အထိ စောင့်နေပါသည်။ SRT အသစ်ကို ထပ်မပို့သေးပါ။');
      const key = task.id + '/' + (task.responseId || task.id);
      if (task.recovery && busyStatusKey !== key) {
        await send({ type: 'WEB_BUSY', id: task.id }); busyStatusKey = key;
      }
      return;
    }
    if (!generating()) await clearOwnedDraft(task);
    // Gemini briefly restores its editor while loading a saved chat. Never erase a draft or mistake hydration for a user draft.
    const editorDeadline = Date.now() + 15000;
    while ((!box || draftText(box).trim()) && Date.now() < editorDeadline) {
      await new Promise(resolve => setTimeout(resolve, 400)); box = editor();
    }
    if (generating()) return;
    if (!box || draftText(box).trim()) {
      const current = await send({ type: 'WEB_TASK' });
      if (current.id !== task.id || current.state !== 'ready') return;
      throw new Error('The dedicated Gemini tab already contains a draft or active response. Finish or clear it, then retry from Udemy.');
    }
    if (await recoverMissingChat(task)) return;
    await selectModel(task.browserModel || 'argon-medium');
    await delay(700);
    if (quotaError()) throw new Error(quotaError());
    // Mark before upload/send: a reload must never silently send the same lecture twice.
    const claim = await send({ type: 'WEB_SENT', id: task.id, clientId });
    if (!claim.claimed) return;
    const current = await send({ type: 'WEB_TASK' });
    if (current.id !== task.id || current.state !== 'waiting') return;
    await deliver({ ...task, ...current, srt: task.srt, prompt: task.prompt });
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
    if (quotaError()) throw new Error(quotaError());
    const box = await waitFor(editor);
    if (generating()) { display('Gemini အဖြေ ထုတ်နေဆဲဖြစ်သဖြင့် ပြီးသည်အထိ စောင့်နေပါသည်။'); return; }
    if (!generating()) await clearOwnedDraft(task);
    if (draftText(box).trim() || generating()) throw new Error('Gemini chat ထဲတွင် draft သို့မဟုတ် အဖြေတစ်ခု ရှိနေပါသည်။ အရင်ရှင်းပြီး Udemy မှ ပြန်စပါ။');
    const claim = await send({ type: 'WEB_REPAIR_SENT', id: task.id, clientId });
    if (!claim.claimed) return;
    const current = await send({ type: 'WEB_TASK' });
    if (current.id !== task.id || current.state !== 'waiting') return;
    await deliver({ ...task, ...current, repairPrompt: task.repairPrompt }, true); lastRaw = ''; stableSince = 0;
    display('စာကြောင်းအရေအတွက် မကိုက်သဖြင့် မူရင်း ID များဖြင့် ပြန်ဘာသာပြန်နေပါသည်။\nအကုန်ပြည့်မှ Udemy တွင် စာတန်းပြပါမည်။');
  }
  function ownedResponse(node, id) {
    const query = latestQuery(), position = query?.compareDocumentPosition?.(node) || 0;
    return queryMatches(id) && (position & 4) && !(position & 1);
  }
  function latestResponse() { return Array.from(document.querySelectorAll('model-response .markdown, model-response message-content, .model-response-text')).at(-1); }
  function transientError(id) {
    const node = latestResponse();
    if (!node || !ownedResponse(node, id)) return null;
    const text = normalize(node.innerText || node.textContent);
    if (!/^(?:Sorry, something went wrong\. Please try your request again\.|I encountered an error doing what you asked\. Could you try again\?|Something went wrong\. Please try again\.?)$/i.test(text)) return null;
    return { node, text };
  }
  async function retryError(task, error) {
    await verifyAccount(task);
    const id = task.responseId || task.id;
    if (task.recovery) {
      const claim = await send({ type: 'WEB_RETRY', id: task.id, responseId: id });
      if (!claim.claimed) return;
    } else {
      if (localRetry.id !== id) localRetry = { id, count: 0, at: 0 };
      if (Date.now() - localRetry.at < 30000 && localRetry.count) return;
      if (localRetry.count >= 2) throw new Error('Gemini error ကို နှစ်ကြိမ်ပြန်စမ်းပြီး မအောင်မြင်ပါ။');
      localRetry.count++; localRetry.at = Date.now();
    }
    const response = error.node.closest?.('model-response');
    const redo = Array.from(response?.querySelectorAll('button') || []).find(b => /^redo$/i.test(b.getAttribute('aria-label') || '')) || buttons().filter(b => /^redo$/i.test(b.getAttribute('aria-label') || '')).at(-1);
    if (!redo) throw new Error('Gemini error ကို ပြန်စမ်းရန် Redo ခလုတ် မတွေ့ပါ။');
    redo.click();
    const choice = await waitFor(() => Array.from(document.querySelectorAll('[role="menuitem"]')).find(e => visible(e) && /^Try again$/i.test(e.textContent.trim())), 10000);
    const current = await send({ type: 'WEB_TASK' });
    if (current.id !== task.id || current.state !== 'waiting' || (current.responseId || current.id) !== id || !ownedResponse(error.node, id)) return;
    choice.click(); lastErrorText = ''; errorSince = 0; lastRaw = ''; stableSince = 0;
    display('Gemini ယာယီ error ကို အလိုအလျောက် ပြန်စမ်းနေပါသည်။ SRT ကို ထပ်မတင်ပါ။');
  }
  function responseText(id) {
    // Only model responses; never accept the prompt, sidebar, or unrelated chat text.
    const nodes = Array.from(document.querySelectorAll('model-response .markdown, model-response message-content, .model-response-text'));
    // Only the latest response can belong to the current job. Avoid materializing old chat history.
    for (const node of nodes.slice(-1)) {
      const text = node.innerText || node.textContent || '';
      const begin = `BEGIN_${id}`, end = `END_${id}`;
      if (!text.includes(end)) {
        // Gemini sometimes returns only JSON. Accept that shape only after
        // the latest visible user turn bearing THIS job's markers. Never
        // attach an old answer or another conversation turn to the job.
        const markers = text.match(/(?:BEGIN|END)_[A-Za-z0-9_]+/g) || [];
        if (markers.some(marker => marker !== begin && marker !== end)) continue;
        const queries = document.querySelectorAll('user-query');
        const query = queries[queries.length - 1];
        const promptText = query?.innerText || query?.textContent || '';
        const position = query?.compareDocumentPosition?.(node) || 0;
        if (!promptText.includes(begin) || !promptText.includes(end) || !(position & 4) || (position & 1)) continue;
      }
      const hasBegin = text.includes(begin);
      // Rendered code blocks include language labels and Copy buttons. Read only the code, keeping job markers.
      const code = Array.from(node.querySelectorAll('pre code'));
      if (code.length === 1) {
        const content = code[0].textContent;
        // A complete JSON code block plus the exact current job's END marker
        // still identifies this response if Gemini omits only BEGIN. The
        // worker validates every numeric cue ID before applying any text.
        if (!hasBegin && !/^\s*\[/.test(content)) continue;
        if (content.includes(begin) || /^\s*\[/.test(content) || /\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(content)) {
          // Gemini may put either marker inside the code block or outside it.
          return (content.includes(begin) ? '' : begin + '\n') + content + (content.includes(end) ? '' : '\n' + end);
        }
      }
      if (hasBegin) return text;
    }
    return '';
  }
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    let task;
    try {
      // Read only the visible signed-in account; account-menu entries are not the current identity.
      const accounts = Array.from(document.querySelectorAll('a[aria-label*="Google Account:"],button[aria-label*="Google Account:"]')).filter(visible);
      const emails = [...new Set(accounts.map(e => (e.getAttribute('aria-label') || '').match(/\(([^\s()]+@[^\s()]+)\)/)?.[1]?.toLowerCase()).filter(Boolean))];
      // Account controls hydrate after a navigation, even when no translation is pending.
      if (location.href && emails.length !== 1 && Date.now() - accountWaitSince < 30000) return;
      if (emails.length === 1 && location.href && reportedAccount !== location.href.split(/[?#]/)[0] + emails[0]) {
        const account = await send({ type: 'WEB_ACCOUNT', email: emails[0] });
        if (account.adopted) reportedAccount = location.href.split(/[?#]/)[0] + emails[0];
        if (account.changed) display('Gemini တွင် ရွေးထားသောအကောင့်ကို extension က လိုက်သုံးပါမည်။ သင်ခန်းစာမှာ Translate နှိပ်ပါ။');
      }
      task = await send({ type: 'WEB_TASK' });
      if (task.idle) { if (notice.isConnected) { display('ဒီဘာသာပြန်လုပ်ငန်းကို ရပ်ထားပါသည်။'); stopped = true; } else if (++idleCount > 5 || !location.hash.includes('udemy-srt=')) stopped = true; return; }
      if (['done', 'cancelled', 'error'].includes(task.state)) {
        if (!generating()) await clearOwnedDraft(task);
        stopped = true;
        display(task.state === 'done' ? 'ဘာသာပြန်ပြီးပါပြီ။ သင်ခန်းစာမှာ စာတန်းထိုး အသင့်ဖြစ်ပါပြီ။' : task.state === 'cancelled' ? 'ဘာသာပြန်မှုကို ရပ်ထားပါသည်။' : task.error);
        return;
      }
      if (await recoverMissingChat(task)) return;
      if (task.state === 'ready') await upload(task);
      if (task.state === 'repair-ready') await repair(task);
      if (task.state === 'waiting') {
        if (task.recovery && task.delivery?.phase !== 'submitted') await deliver(task, !!task.repair);
        const error = !generating() && transientError(task.responseId || task.id);
        if (error) {
          if (lastErrorText !== error.text) { lastErrorText = error.text; errorSince = Date.now(); return; }
          if (Date.now() - errorSince >= 3000) await retryError(task, error);
          return;
        }
        lastErrorText = ''; errorSince = 0;
        const raw = responseText(task.responseId || task.id);
        if (!raw || generating()) {
          if (!generating() && quotaError()) throw new Error(quotaError());
          lastRaw = ''; stableSince = 0; return;
        }
        if (raw !== lastRaw) { lastRaw = raw; stableSince = Date.now(); return; }
        if (Date.now() - stableSince >= 3000) {
          const result = await send({ type: 'WEB_RESULT', id: task.id, responseId: task.responseId || task.id, raw });
          if (result.repair) { lastRaw = ''; stableSince = 0; display('စာကြောင်းမပြည့်သဖြင့် အလိုအလျောက် ပြန်တောင်းနေပါသည်။'); return; }
          if (!result.done) { lastRaw = ''; stableSince = 0; return; }
          display('ဘာသာပြန်ပြီးပါပြီ။ သင်ခန်းစာမှာ စာတန်းထိုး အသင့်ဖြစ်ပါပြီ။'); stopped = true;
        }
      }
    } catch (error) {
      if (task?.id && !generating()) { try { const current = await send({ type: 'WEB_TASK' }); if (current.id === task.id) await clearOwnedDraft(current); } catch { /* Preserve an attachment if ownership cannot be proved. */ } }
      display(error.message);
      if (task?.id) { try { await send({ type: 'WEB_ERROR', id: task.id, responseId: task.responseId || task.id, error: error.message }); } catch {} }
      stopped = true;
    } finally {
      busy = false;
      if (wakePending) { wakePending = false; stopped = false; startPolling(); tick(); }
      else if (stopped) stopPolling();
    }
  }
  // Idle between jobs without polling the worker. A new lecture wakes this same chat adapter.
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) chrome.runtime.onMessage?.addListener((message, sender, respond) => {
    if (!['BROWSER_JOB_AVAILABLE', 'BROWSER_ACCOUNT_CHECK'].includes(message?.type)) return false;
    if (message.type === 'BROWSER_ACCOUNT_CHECK') { reportedAccount = ''; accountWaitSince = Date.now(); }
    stopped = false; missingKey = ''; lastRaw = ''; stableSince = 0; idleCount = 0; lastErrorText = ''; errorSince = 0;
    startPolling();
    if (busy) wakePending = true; else tick(); respond?.({ ok: true }); return false;
  });
  startPolling();
  tick();
})(typeof chrome !== 'undefined' && chrome.runtime?.id ? message => chrome.runtime.sendMessage(message) : globalThis.__udemySubtitleTransport);
