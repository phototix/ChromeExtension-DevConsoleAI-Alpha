const storageKeys = {
  apiKey: 'devConsoleAiApiKey',
  model: 'devConsoleAiModel',
  chatHistory: 'devConsoleAiChatHistory',
  theme: 'devConsoleAiTheme'
};

const state = {
  activeSessionId: null,
  history: [],
  selectedContext: null,
  selectedContextType: 'none',
  contextCaptureId: 0,
  domPicker: null,
  themePreference: 'dark',
  themeMediaQuery: null,
  consoleRefreshTimer: null,
  networkRefreshTimer: null,
  liveRefreshId: 0,
  renameSessionId: null,
  deleteSessionId: null
};

function serializeDomElement(element) {
  const selectorParts = [];
  const breadcrumbs = [];
  let current = element;
  while (current && current.nodeType === 1 && selectorParts.length < 24) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      part += `#${CSS.escape(current.id)}`;
    }
    part += Array.from(current.classList)
      .slice(0, 3)
      .map((className) => `.${CSS.escape(className)}`)
      .join('');
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current.tagName)
      : [];
    if (siblings.length > 1) {
      part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    selectorParts.unshift(part);
    breadcrumbs.unshift(
      current.tagName.toLowerCase() +
      (current.id ? `#${current.id}` : '') +
      (current.classList.length ? `.${Array.from(current.classList).slice(0, 3).join('.')}` : '')
    );
    current = current.parentElement;
  }

  const html = element.outerHTML || '';
  return {
    selector: selectorParts.join(' > '),
    breadcrumbs: breadcrumbs.join(' > '),
    root: element.getRootNode() instanceof ShadowRoot ? 'shadow DOM' : 'document',
    tagName: element.tagName.toLowerCase(),
    id: element.id || null,
    classes: Array.from(element.classList),
    text: (element.innerText || element.textContent || '').trim().slice(0, 1000),
    outerHTML: html.slice(0, 30000),
    truncated: html.length > 30000
  };
}

const consoleCaptureExpression = `(() => {
  if (!window.__devConsoleAiInjected) {
    const logs = [];
    const maxLogs = 200;
    const stringify = (value) => {
      try {
        return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      } catch (error) {
        return String(value);
      }
    };
    const capture = (level, args) => {
      logs.push({
        level,
        message: args.map((arg) => stringify(arg)).join(' '),
        stamp: new Date().toISOString()
      });
      if (logs.length > maxLogs) {
        logs.splice(0, logs.length - maxLogs);
      }
    };
    ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
      const original = console[level];
      console[level] = (...args) => {
        capture(level, args);
        return original.apply(console, args);
      };
    });
    window.addEventListener('error', (event) => {
      capture('error', [event.message, event.filename, event.lineno, event.colno].filter(Boolean));
    });
    window.addEventListener('unhandledrejection', (event) => {
      capture('error', ['Unhandled promise rejection:', event.reason]);
    });
    window.__devConsoleAiLogs = logs;
    window.__devConsoleAiInjected = true;
  }
  return JSON.stringify(window.__devConsoleAiLogs || []);
})()`;

window.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', () => {
  stopDomPicker(false);
  stopLiveContextRefresh();
});

function init() {
  bindUi();
  loadHistory();
  loadTheme();
  installConsoleCapture().catch((error) => {
    state.consoleCaptureError = error.message;
    setContextStatus(`Console capture unavailable: ${error.message}`);
  });
  chrome.devtools.network.onRequestFinished.addListener(() => {
    if (state.selectedContextType === 'network') {
      scheduleNetworkRefresh();
    }
  });
  chrome.devtools.network.onNavigated.addListener(() => {
    installConsoleCapture().catch((error) => {
      state.consoleCaptureError = error.message;
      if (state.selectedContextType === 'console') {
        setContextStatus(`Console capture unavailable: ${error.message}`);
      }
    });
    if (state.selectedContextType === 'console') {
      refreshLiveContext('console');
    }
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[storageKeys.theme]) {
      applyTheme(changes[storageKeys.theme].newValue || 'dark');
    }
  });
  state.themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  state.themeMediaQuery.addEventListener('change', () => {
    if (state.themePreference === 'system') {
      applyTheme('system');
    }
  });
}

function loadTheme() {
  chrome.storage.local.get(storageKeys.theme, (result) => {
    if (chrome.runtime.lastError) {
      setContextStatus(`Could not load theme: ${chrome.runtime.lastError.message}`);
      applyTheme('dark');
      return;
    }
    applyTheme(result[storageKeys.theme] || 'dark');
  });
}

function applyTheme(preference) {
  const validPreference = ['light', 'dark', 'system'].includes(preference) ? preference : 'dark';
  state.themePreference = validPreference;
  const isDark = validPreference === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : validPreference === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
}

function bindUi() {
  document.getElementById('newChatBtn').addEventListener('click', () => {
    const session = createSession();
    state.activeSessionId = session.id;
    renderHistory();
    renderMessages();
  });

  document.getElementById('contextType').addEventListener('change', (event) => {
    state.selectedContextType = event.target.value;
    state.contextCaptureId += 1;
    stopDomPicker(false);
    state.selectedContext = null;
    document.getElementById('viewContextBtn').disabled = true;
    const contextDialog = document.getElementById('contextDialog');
    if (contextDialog.open) {
      contextDialog.close();
    }
    if (state.selectedContextType === 'none') {
      setContextStatus('');
      updateContextActions();
      return;
    }

    captureContext(state.selectedContextType);
  });
  document.getElementById('viewContextBtn').addEventListener('click', showContextDialog);
  document.getElementById('clearContextBtn').addEventListener('click', clearAttachedContext);
  document.getElementById('regrabDomBtn').addEventListener('click', () => {
    captureContext('dom', { preserveExisting: true });
  });
  document.getElementById('cancelDomPickBtn').addEventListener('click', () => stopDomPicker(true));
  document.getElementById('closeContextDialogBtn').addEventListener('click', () => {
    document.getElementById('contextDialog').close();
  });
  document.getElementById('contextDialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      event.currentTarget.close();
    }
  });
  document.getElementById('renameForm').addEventListener('submit', saveRenamedSession);
  document.getElementById('cancelRenameBtn').addEventListener('click', () => {
    document.getElementById('renameDialog').close();
  });
  document.getElementById('renameDialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      event.currentTarget.close();
    }
  });
  document.getElementById('renameDialog').addEventListener('close', () => {
    state.renameSessionId = null;
  });
  document.getElementById('cancelDeleteBtn').addEventListener('click', () => {
    document.getElementById('deleteDialog').close();
  });
  document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDeleteSession);
  document.getElementById('deleteDialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      event.currentTarget.close();
    }
  });
  document.getElementById('deleteDialog').addEventListener('close', () => {
    state.deleteSessionId = null;
  });
  document.getElementById('chatMessages').addEventListener('click', (event) => {
    const exportButton = event.target.closest('[data-table-export]');
    if (!exportButton) {
      return;
    }

    const table = exportButton.closest('.table-container')?.querySelector('table');
    if (!table) {
      return;
    }

    try {
      downloadTable(table, exportButton.dataset.tableExport);
    } catch (error) {
      setContextStatus(`Table export failed: ${error.message}`);
    }
  });

  const composer = document.getElementById('composer');
  const promptInput = document.getElementById('promptInput');
  promptInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) {
      return;
    }

    event.preventDefault();
    if (!document.getElementById('sendBtn').disabled) {
      composer.requestSubmit();
    }
  });

  composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const prompt = document.getElementById('promptInput').value.trim();
    if (!prompt) {
      return;
    }

    if (!state.activeSessionId) {
      const session = createSession();
      state.activeSessionId = session.id;
    }

    const session = state.history.find((item) => item.id === state.activeSessionId);
    if (!session) {
      return;
    }

    const shouldGenerateTitle = session.messages.length === 0 && session.titleSource !== 'manual';
    const userMessage = { role: 'user', text: prompt };
    session.messages.push(userMessage);
    if (shouldGenerateTitle) {
      session.title = createPromptTitle(prompt);
      session.titleSource = 'prompt';
    }
    renderMessages();
    renderHistory();
    document.getElementById('promptInput').value = '';

    const sendButton = document.getElementById('sendBtn');
    const contextTypeSelect = document.getElementById('contextType');
    sendButton.disabled = true;
    contextTypeSelect.disabled = true;

    try {
      let contextText = '';
      if (state.selectedContextType !== 'none') {
        const context = state.selectedContextType === 'dom'
          ? state.selectedContext
          : await captureContext(state.selectedContextType);
        if (context === null) {
          session.messages.push({
            role: 'assistant',
            text: state.selectedContextType === 'dom'
              ? 'Select a DOM element before sending with DOM context enabled.'
              : 'I could not capture the selected page context. Check the message above, then try again.'
          });
          return;
        }
        contextText = formatContext(state.selectedContextType, context);
      }

      userMessage.contextText = contextText;
      const answer = await askDeepSeek(session.messages);
      session.messages.push({ role: 'assistant', text: answer });
      if (shouldGenerateTitle && !answer.startsWith('Missing DeepSeek API key.')) {
        generateSessionTitle(session, prompt);
      }
    } catch (error) {
      session.messages.push({ role: 'assistant', text: `Request failed: ${error.message}` });
    } finally {
      sendButton.disabled = false;
      contextTypeSelect.disabled = false;
      saveHistory();
      renderMessages();
      renderHistory();
    }
  });
}

function createSession() {
  const session = {
    id: `chat-${Date.now()}`,
    title: 'New chat',
    titleSource: 'prompt',
    messages: []
  };
  state.history.unshift(session);
  state.activeSessionId = session.id;
  saveHistory();
  return session;
}

function loadHistory() {
  chrome.storage.local.get(storageKeys.chatHistory, (result) => {
    const storedHistory = result[storageKeys.chatHistory] || [];
    state.history = storedHistory;

    if (state.history.length === 0) {
      const session = createSession();
      state.activeSessionId = session.id;
      renderHistory();
      renderMessages();
      return;
    }

    state.activeSessionId = state.history[0].id;
    renderHistory();
    renderMessages();
  });
}

function saveHistory() {
  chrome.storage.local.set({
    [storageKeys.chatHistory]: state.history
  });
}

function renderHistory() {
  const historyList = document.getElementById('historyList');
  document.querySelectorAll('.history-menu-content').forEach((menu) => menu.remove());
  historyList.innerHTML = '';

  state.history.forEach((session) => {
    const row = document.createElement('div');
    row.className = 'history-item-row';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item';
    if (session.id === state.activeSessionId) {
      button.classList.add('active');
    }

    const title = document.createElement('div');
    title.textContent = session.title || 'New chat';
    const meta = document.createElement('small');
    meta.textContent = `${session.messages.length} messages`;

    button.appendChild(title);
    button.appendChild(meta);
    button.addEventListener('click', () => {
      state.activeSessionId = session.id;
      renderHistory();
      renderMessages();
    });

    const menu = document.createElement('div');
    menu.className = 'history-menu';
    const menuTrigger = document.createElement('button');
    menuTrigger.type = 'button';
    menuTrigger.className = 'history-menu-trigger';
    menuTrigger.textContent = '⋯';
    menuTrigger.setAttribute('aria-label', `Actions for ${session.title || 'New chat'}`);
    menuTrigger.setAttribute('aria-haspopup', 'menu');
    menuTrigger.setAttribute('aria-expanded', 'false');
    const menuContent = document.createElement('div');
    menuContent.className = 'history-menu-content';
    menuContent.setAttribute('popover', 'auto');
    menuContent.setAttribute('role', 'menu');
    menuTrigger.addEventListener('click', () => {
      if (menuContent.matches(':popover-open')) {
        menuContent.hidePopover();
        return;
      }

      menuContent.showPopover();
      const triggerRect = menuTrigger.getBoundingClientRect();
      const popoverRect = menuContent.getBoundingClientRect();
      const left = Math.max(8, Math.min(triggerRect.right - popoverRect.width, window.innerWidth - popoverRect.width - 8));
      const belowTop = triggerRect.bottom + 4;
      const top = belowTop + popoverRect.height <= window.innerHeight - 8
        ? belowTop
        : Math.max(8, triggerRect.top - popoverRect.height - 4);
      menuContent.style.left = `${left}px`;
      menuContent.style.top = `${top}px`;
    });
    menuContent.addEventListener('toggle', (event) => {
      menuTrigger.setAttribute('aria-expanded', event.newState === 'open' ? 'true' : 'false');
    });
    const renameButton = document.createElement('button');
    renameButton.type = 'button';
    renameButton.className = 'history-menu-action';
    renameButton.setAttribute('role', 'menuitem');
    renameButton.textContent = 'Rename';
    renameButton.addEventListener('click', () => {
      menuContent.hidePopover();
      openRenameDialog(session);
    });
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'history-menu-action delete-action';
    deleteButton.setAttribute('role', 'menuitem');
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => {
      menuContent.hidePopover();
      openDeleteDialog(session);
    });

    menuContent.append(renameButton, deleteButton);
    menu.append(menuTrigger);
    document.body.appendChild(menuContent);
    row.append(button, menu);
    historyList.appendChild(row);
  });
}

function deleteSession(session) {
  const sessionIndex = state.history.findIndex((item) => item.id === session.id);
  if (sessionIndex < 0) {
    return;
  }

  const deletesActiveSession = session.id === state.activeSessionId;
  state.history.splice(sessionIndex, 1);
  let replacementCreated = false;
  if (deletesActiveSession) {
    if (state.history.length > 0) {
      state.activeSessionId = state.history[0].id;
    } else {
      createSession();
      replacementCreated = true;
    }
  }

  if (!replacementCreated) {
    saveHistory();
  }
  renderHistory();
  if (deletesActiveSession) {
    renderMessages();
  }
}

function openDeleteDialog(session) {
  state.deleteSessionId = session.id;
  document.getElementById('deleteDialogMessage').textContent =
    `Delete "${session.title || 'New chat'}"? This action cannot be undone.`;
  document.getElementById('deleteDialog').showModal();
  document.getElementById('cancelDeleteBtn').focus();
}

function confirmDeleteSession() {
  const session = state.history.find((item) => item.id === state.deleteSessionId);
  if (!session) {
    setContextStatus('Could not delete conversation because it is no longer available.');
    document.getElementById('deleteDialog').close();
    return;
  }

  state.deleteSessionId = null;
  document.getElementById('deleteDialog').close();
  deleteSession(session);
}

function openRenameDialog(session) {
  state.renameSessionId = session.id;
  const input = document.getElementById('renameTitleInput');
  input.value = session.title || '';
  input.setCustomValidity('');
  document.getElementById('renameDialog').showModal();
  input.focus();
  input.select();
}

function saveRenamedSession(event) {
  event.preventDefault();
  const session = state.history.find((item) => item.id === state.renameSessionId);
  if (!session) {
    setContextStatus('Could not rename conversation because it is no longer available.');
    return;
  }

  const input = document.getElementById('renameTitleInput');
  const title = normalizeConversationTitle(input.value);
  if (!title) {
    input.setCustomValidity('Enter a conversation title.');
    input.reportValidity();
    return;
  }

  session.title = title;
  session.titleSource = 'manual';
  delete session.titleGenerationError;
  state.renameSessionId = null;
  document.getElementById('renameDialog').close();
  saveHistory();
  renderHistory();
}

function renderMessages() {
  const chatMessages = document.getElementById('chatMessages');
  const activeSession = state.history.find((item) => item.id === state.activeSessionId);

  if (!activeSession || activeSession.messages.length === 0) {
    chatMessages.innerHTML = '<div class="empty-state">Ask about the inspected page. Attach console, DOM, or network data for context.</div>';
    return;
  }

  chatMessages.innerHTML = '';
  activeSession.messages.forEach((message) => {
    const wrapper = document.createElement('article');
    wrapper.className = `message ${message.role}`;

    const header = document.createElement('div');
    header.className = 'message-header';

    const role = document.createElement('span');
    role.className = 'message-role';
    role.textContent = message.role === 'user' ? 'You' : 'AI';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(message.text);
        copyBtn.textContent = 'Copied';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 1200);
      } catch (error) {
        copyBtn.textContent = 'Copy failed';
      }
    });

    header.appendChild(role);
    header.appendChild(copyBtn);

    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = renderMarkdown(message.text);

    wrapper.appendChild(header);
    wrapper.appendChild(body);
    chatMessages.appendChild(wrapper);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showContextDialog() {
  if (state.selectedContext === null) {
    return;
  }

  document.getElementById('contextDialogTitle').textContent = `${contextLabel(state.selectedContextType)} data`;
  document.getElementById('contextDialogContent').textContent = state.selectedContext;
  document.getElementById('contextDialog').showModal();
}

async function captureContext(type = document.getElementById('contextType').value, options = {}) {
  const contextTypeSelect = document.getElementById('contextType');
  if (type !== contextTypeSelect.value) {
    return null;
  }

  const preserveExisting = options.preserveExisting && state.selectedContext !== null;
  stopLiveContextRefresh();
  const captureId = ++state.contextCaptureId;
  try {
    if (type === 'none') {
      state.selectedContext = null;
      document.getElementById('viewContextBtn').disabled = true;
      setContextStatus('');
      updateContextActions();
      return null;
    }

    if (!preserveExisting) {
      state.selectedContext = null;
      document.getElementById('viewContextBtn').disabled = true;
      updateContextActions();
    }
    if (type === 'dom') {
      document.getElementById('cancelDomPickBtn').hidden = false;
      document.getElementById('sendBtn').disabled = true;
      setContextStatus('Hover and click an element, or select a node in Elements and return here.');
    } else {
      setContextStatus('Capturing…');
    }

    const result = await collectContext(type, captureId);
    if (captureId !== state.contextCaptureId || type !== contextTypeSelect.value) {
      return null;
    }

    if (result === null) {
      document.getElementById('cancelDomPickBtn').hidden = true;
      document.getElementById('sendBtn').disabled = false;
      setContextStatus(preserveExisting ? 'Selection cancelled; previous DOM data kept' : 'Selection cancelled');
      updateContextActions();
      return null;
    }

    state.selectedContext = result;
    state.selectedContextType = type;
    document.getElementById('viewContextBtn').disabled = false;
    document.getElementById('cancelDomPickBtn').hidden = true;
    document.getElementById('sendBtn').disabled = false;
    setContextStatus('Attached');
    updateContextActions();
    startLiveContextRefresh(type);
    return result;
  } catch (error) {
    if (captureId === state.contextCaptureId && type === contextTypeSelect.value) {
      if (!preserveExisting) {
        state.selectedContext = null;
        document.getElementById('viewContextBtn').disabled = true;
      }
      document.getElementById('cancelDomPickBtn').hidden = true;
      document.getElementById('sendBtn').disabled = false;
      setContextStatus(preserveExisting ? 'Selection failed; previous DOM data kept' : 'Capture failed');
      document.getElementById('contextStatus').title = error.message;
      updateContextActions();
    }
    return null;
  }
}

function updateContextActions() {
  const hasContext = state.selectedContext !== null;
  document.getElementById('viewContextBtn').disabled = !hasContext;
  document.getElementById('clearContextBtn').hidden = !hasContext;
  document.getElementById('regrabDomBtn').hidden = !hasContext || state.selectedContextType !== 'dom';
}

function clearAttachedContext() {
  state.contextCaptureId += 1;
  stopDomPicker(false);
  stopLiveContextRefresh();
  state.selectedContext = null;
  state.selectedContextType = 'none';
  document.getElementById('contextType').value = 'none';
  document.getElementById('sendBtn').disabled = false;
  document.getElementById('cancelDomPickBtn').hidden = true;
  const contextDialog = document.getElementById('contextDialog');
  if (contextDialog.open) {
    contextDialog.close();
  }
  updateContextActions();
  setContextStatus('');
}

function captureElementsPanelSelection(fromElementsPanel = false) {
  const contextTypeSelect = document.getElementById('contextType');
  if (!fromElementsPanel && contextTypeSelect.value !== 'dom') {
    return;
  }

  if (fromElementsPanel) {
    if (state.selectedContextType !== 'dom') {
      state.selectedContext = null;
      document.getElementById('viewContextBtn').disabled = true;
    }
    contextTypeSelect.value = 'dom';
    state.selectedContextType = 'dom';
    updateContextActions();
  }

  const captureId = ++state.contextCaptureId;
  stopDomPicker(false);
  stopLiveContextRefresh();
  document.getElementById('cancelDomPickBtn').hidden = true;
  document.getElementById('sendBtn').disabled = true;
  setContextStatus('Reading selected node from the Elements panel…');

  const expression = `(() => {
    const selected = typeof $0 === 'undefined' ? null : $0;
    const element = selected instanceof Element ? selected : selected && selected.parentElement;
    if (!element) return null;
    const serialize = ${serializeDomElement.toString()};
    return JSON.stringify(serialize(element));
  })()`;
  chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
    if (captureId !== state.contextCaptureId || document.getElementById('contextType').value !== 'dom') {
      return;
    }

    document.getElementById('sendBtn').disabled = false;
    if (exceptionInfo) {
      setContextStatus('Could not read the Elements panel selection');
      document.getElementById('contextStatus').title =
        exceptionInfo.description || 'Elements panel selection failed';
      return;
    }
    if (typeof result !== 'string') {
      setContextStatus('Select an element in Chrome’s Elements panel first, then return here.');
      return;
    }

    state.selectedContext = result;
    state.selectedContextType = 'dom';
    document.getElementById('viewContextBtn').disabled = false;
    setContextStatus('Attached from Elements panel');
    updateContextActions();
  });
}

window.captureElementsPanelSelection = captureElementsPanelSelection;

function contextLabel(type) {
  return {
    dom: 'DOM',
    console: 'console',
    network: 'network',
    page: 'page metadata'
  }[type] || type;
}

function setContextStatus(message) {
  const status = document.getElementById('contextStatus');
  status.textContent = message;
  if (message !== 'Capture failed') {
    status.removeAttribute('title');
  }
}

function collectContext(type, captureId) {
  return new Promise((resolve, reject) => {
    if (type === 'dom') {
      startDomPicker(captureId).then(resolve, reject);
      return;
    }

    if (type === 'console') {
      readConsoleLogs().then(resolve, reject);
      return;
    }

    if (type === 'network') {
      chrome.devtools.network.getHAR((har) => {
        const entries = (har?.entries || []).slice(-40).map(formatNetworkEntry);
        resolve(JSON.stringify(entries, null, 2));
      });
      return;
    }

    if (type === 'page') {
      chrome.devtools.inspectedWindow.eval(
        '(() => ({ url: location.href, title: document.title, readyState: document.readyState, viewport: { width: window.innerWidth, height: window.innerHeight } }))()',
        (result, exceptionInfo) => {
          if (exceptionInfo) {
            reject(new Error(exceptionInfo?.description || 'Page metadata capture failed'));
            return;
          }
          resolve(JSON.stringify(result, null, 2));
        }
      );
      return;
    }

    reject(new Error(`Unsupported context type: ${type}`));
  });
}

function installConsoleCapture() {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(consoleCaptureExpression, (result, exceptionInfo) => {
      if (exceptionInfo) {
        reject(new Error(exceptionInfo.description || 'Console capture failed'));
        return;
      }
      resolve(result);
    });
  });
}

function readConsoleLogs() {
  return installConsoleCapture().then((result) => {
    const logs = parseJsonSafe(result);
    return Array.isArray(logs) && logs.length > 0
      ? JSON.stringify(logs, null, 2)
      : 'No console logs captured yet.';
  });
}

function formatNetworkEntry(entry) {
  const request = entry.request || {};
  const response = entry.response || {};
  return {
    url: request.url || '',
    method: request.method || 'unknown',
    status: response.status ?? 'unknown',
    type: entry._resourceType || response.content?.mimeType || 'unknown',
    size: Math.max(0, response.headersSize || 0) + Math.max(0, response.bodySize || 0),
    time: entry.time
  };
}

function startLiveContextRefresh(type) {
  if (type === 'console') {
    state.consoleRefreshTimer = window.setInterval(() => refreshLiveContext('console'), 1000);
  }
  if (type === 'console' || type === 'network') {
    setContextStatus('Live updates on');
  }
}

function stopLiveContextRefresh() {
  if (state.consoleRefreshTimer !== null) {
    window.clearInterval(state.consoleRefreshTimer);
    state.consoleRefreshTimer = null;
  }
  if (state.networkRefreshTimer !== null) {
    window.clearTimeout(state.networkRefreshTimer);
    state.networkRefreshTimer = null;
  }
  state.liveRefreshId += 1;
}

function scheduleNetworkRefresh() {
  if (state.networkRefreshTimer !== null) {
    window.clearTimeout(state.networkRefreshTimer);
  }
  state.networkRefreshTimer = window.setTimeout(() => {
    state.networkRefreshTimer = null;
    refreshLiveContext('network');
  }, 250);
}

function refreshLiveContext(type) {
  const captureId = state.contextCaptureId;
  const refreshId = ++state.liveRefreshId;
  collectContext(type, captureId).then((result) => {
    if (
      result === null
      || refreshId !== state.liveRefreshId
      || captureId !== state.contextCaptureId
      || type !== state.selectedContextType
      || type !== document.getElementById('contextType').value
    ) {
      return;
    }
    state.selectedContext = result;
    const dialog = document.getElementById('contextDialog');
    if (dialog.open) {
      document.getElementById('contextDialogContent').textContent = result;
    }
  }).catch((error) => {
    if (refreshId === state.liveRefreshId && type === state.selectedContextType) {
      setContextStatus(`Live update failed: ${error.message}`);
    }
  });
}

function startDomPicker(captureId) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let checking = false;
    let pickerInstalled = false;
    let pollTimer;

    const finish = (result, error) => {
      if (finished) {
        return;
      }

      finished = true;
      clearInterval(pollTimer);
      if (state.domPicker && state.domPicker.finish === finish) {
        state.domPicker = null;
      }
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const cancel = () => {
      if (finished) {
        return;
      }

      if (!pickerInstalled) {
        finish(null);
        return;
      }

      chrome.devtools.inspectedWindow.eval(
        `(() => {
          const picker = window['${pickerKey}'];
          if (picker && picker.cleanup) picker.cleanup();
          delete window['${pickerKey}'];
        })()`,
        () => finish(null)
      );
    };

    const pickerKey = '__devConsoleAiDomPicker';
    const installExpression = `(() => {
      const key = '${pickerKey}';
      if (window[key] && window[key].cleanup) window[key].cleanup();

      const picker = { result: null, cancelled: false, cleanup: null };
      const overlay = document.createElement('div');
      const label = document.createElement('span');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = 'position:fixed;display:none;pointer-events:none;z-index:2147483647;border:2px solid #38bdf8;background:rgba(56,189,248,.12);box-shadow:0 0 0 99999px rgba(2,6,23,.06);';
      label.style.cssText = 'position:absolute;left:-2px;top:-23px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 6px;border-radius:4px 4px 0 0;background:#0284c7;color:white;font:12px/16px sans-serif;';
      overlay.appendChild(label);
      document.documentElement.appendChild(overlay);

      const getElement = (event) => {
        const path = typeof event.composedPath === 'function'
          ? event.composedPath()
          : [event.target];
        return path.find((node) =>
          node instanceof Element &&
          node !== overlay &&
          !overlay.contains(node)
        ) || null;
      };
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        overlay.style.display = 'block';
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = Math.max(0, rect.width) + 'px';
        overlay.style.height = Math.max(0, rect.height) + 'px';
        label.textContent = element.tagName.toLowerCase() +
          (element.id ? '#' + element.id : '') +
          (element.classList.length ? '.' + Array.from(element.classList).slice(0, 3).join('.') : '');
      };
      const onMove = (event) => {
        const element = getElement(event);
        if (element) describe(element);
      };
      const onClick = (event) => {
        const element = getElement(event);
        if (!element) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const serialize = ${serializeDomElement.toString()};
        picker.result = JSON.stringify(serialize(element));
        picker.cleanup();
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          picker.cancelled = true;
          picker.cleanup();
        }
      };
      picker.cleanup = () => {
        document.removeEventListener('mouseover', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
      };
      document.addEventListener('mouseover', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
      window[key] = picker;
      return true;
    })()`;

    state.domPicker = { finish, cancel };

    const readSelection = () => {
      if (finished || checking) {
        return;
      }
      checking = true;
      chrome.devtools.inspectedWindow.eval(
        `(() => {
          const picker = window['${pickerKey}'];
          if (!picker) return { cancelled: true };
          if (picker.cancelled) {
            delete window['${pickerKey}'];
            return { cancelled: true };
          }
          if (picker.result !== null) {
            const result = picker.result;
            delete window['${pickerKey}'];
            return { result };
          }
          return null;
        })()`,
        (value, exceptionInfo) => {
          checking = false;
          if (finished) {
            return;
          }
          if (exceptionInfo) {
            finish(null, new Error(exceptionInfo.description || 'DOM selection failed'));
            return;
          }
          if (value && value.cancelled) {
            finish(null);
          } else if (value && value.result) {
            finish(value.result);
          }
        }
      );
    };

    chrome.devtools.inspectedWindow.eval(installExpression, (result, exceptionInfo) => {
      if (exceptionInfo) {
        finish(null, new Error(exceptionInfo.description || 'Could not start DOM selection'));
        return;
      }
      if (result !== true) {
        finish(null, new Error('Could not start DOM selection'));
        return;
      }
      pickerInstalled = true;
      if (finished) {
        chrome.devtools.inspectedWindow.eval(
          `(() => {
            const picker = window['${pickerKey}'];
            if (picker && picker.cleanup) picker.cleanup();
            delete window['${pickerKey}'];
          })()`
        );
        return;
      }
      if (captureId !== state.contextCaptureId || document.getElementById('contextType').value !== 'dom') {
        chrome.devtools.inspectedWindow.eval(
          `(() => {
            const picker = window['${pickerKey}'];
            if (picker && picker.cleanup) picker.cleanup();
            delete window['${pickerKey}'];
          })()`,
          () => finish(null)
        );
        return;
      }

      pollTimer = setInterval(readSelection, 250);
    });
  });
}

function stopDomPicker(showStatus) {
  if (!state.domPicker) {
    return;
  }

  const picker = state.domPicker;
  picker.cancel();
  document.getElementById('cancelDomPickBtn').hidden = true;
  document.getElementById('sendBtn').disabled = false;
  if (showStatus) {
    setContextStatus('Selection cancelled');
  }
}

function parseJsonSafe(value) {
  if (!value) {
    return '';
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return String(value);
  }
}

function formatContext(type, content) {
  const collation = {
    dom: 'DOM snapshot',
    console: 'Console log snapshot',
    network: 'Network data',
    page: 'Page metadata'
  };

  if (!content) {
    return '';
  }

  return `Context type: ${collation[type] || 'Custom'}\n\n${content}`;
}

async function askDeepSeek(conversation) {
  const settings = await loadApiSettings();
  const apiKey = settings[storageKeys.apiKey] || '';

  if (!apiKey) {
    return 'Missing DeepSeek API key. Click the extension icon in the Chrome toolbar to configure it.';
  }

  const messages = [
    {
      role: 'system',
      content: 'You are a helpful frontend debugging assistant. Use the provided page context to answer the user accurately and concisely.'
    },
    ...conversation
      .filter((message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.text === 'string'
      )
      .map((message) => ({
        role: message.role,
        content: message.role === 'user' && message.contextText
          ? `${message.text}\n\n--- ATTACHED CONTEXT ---\n${message.contextText}`
          : message.text
      }))
  ];

  return requestDeepSeek(settings, messages, 0.2);
}

async function loadApiSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([storageKeys.apiKey, storageKeys.model], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`Could not load API settings: ${chrome.runtime.lastError.message}`));
        return;
      }
      resolve(result);
    });
  });
}

async function requestDeepSeek(settings, messages, temperature) {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings[storageKeys.apiKey]}`
    },
    body: JSON.stringify({
      model: settings[storageKeys.model] || 'deepseek-chat',
      messages,
      temperature,
      stream: false
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`DeepSeek request failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || 'No response returned by DeepSeek.';
}

function createPromptTitle(prompt) {
  return normalizeConversationTitle(prompt).slice(0, 180) || 'New chat';
}

function normalizeConversationTitle(value) {
  return String(value || '')
    .trim()
    .split(/\r?\n/, 1)[0]
    .replace(/^title:\s*/i, '')
    .replace(/^[`"'“”]+|[`"'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function generateSessionTitle(session, prompt) {
  const titleMessages = [
    {
      role: 'system',
      content: 'Create a concise, descriptive title for a debugging chat based only on the user message. Use at most 180 characters. Return only the title, with no quotes or explanation.'
    },
    { role: 'user', content: prompt }
  ];

  loadApiSettings()
    .then((settings) => {
      if (!settings[storageKeys.apiKey]) {
        throw new Error('DeepSeek API key is not configured.');
      }
      return requestDeepSeek(settings, titleMessages, 0.2);
    })
    .then((response) => {
      const title = normalizeConversationTitle(response);
      if (!title || title === 'No response returned by DeepSeek.') {
        throw new Error('DeepSeek did not return a usable title.');
      }
      if (session.titleSource === 'manual') {
        return;
      }

      session.title = title;
      session.titleSource = 'generated';
      delete session.titleGenerationError;
      saveHistory();
      renderHistory();
    })
    .catch((error) => {
      if (session.titleSource === 'manual') {
        return;
      }
      session.titleGenerationError = error.message;
      saveHistory();
      renderHistory();
      setContextStatus('Could not generate a chat title; keeping a shortened version of your first message.');
      document.getElementById('contextStatus').title = error.message;
    });
}

function renderMarkdown(markdown) {
  if (!markdown) {
    return '<p class="empty-state">No content.</p>';
  }

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let index = 0;
  let tableCount = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && isMarkdownTable(lines[index], lines[index + 1])) {
      const headers = splitTableRow(lines[index]);
      const alignments = splitTableRow(lines[index + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      index += 2;

      const rows = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }

      const renderCell = (cell, cellIndex, tag) => {
        const alignment = alignments[cellIndex];
        const style = alignment ? ` style="text-align:${alignment}"` : '';
        return `<${tag}${style}>${formatInline(cell)}</${tag}>`;
      };
      const headerHtml = headers.map((cell, cellIndex) => renderCell(cell, cellIndex, 'th')).join('');
      const rowsHtml = rows.map((row) => {
        const cells = headers.map((_, cellIndex) => renderCell(row[cellIndex] || '', cellIndex, 'td')).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      tableCount += 1;
      output.push(
        `<div class="table-container"><div class="table-actions">` +
        `<button class="table-export-btn" type="button" data-table-export="csv">Download CSV</button>` +
        `<button class="table-export-btn" type="button" data-table-export="xlsx">Download Excel</button>` +
        `</div><div class="table-scroll"><table data-table-number="${tableCount}"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div></div>`
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      output.push(`<blockquote>${quoteLines.map((quoteLine) => `<p>${formatInline(quoteLine)}</p>`).join('')}</blockquote>`);
      continue;
    }

    const listMatch = line.match(/^([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /^\d+\./.test(listMatch[1]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^([-*+]|\d+\.)\s+(.+)$/);
        if (!itemMatch || /^\d+\./.test(itemMatch[1]) !== ordered) {
          break;
        }
        items.push(`<li>${formatInline(itemMatch[2])}</li>`);
        index += 1;
      }
      output.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() &&
      !/^(#{1,6})\s|^```|^>\s?/.test(lines[index].trim()) &&
      !(index + 1 < lines.length && isMarkdownTable(lines[index], lines[index + 1])) &&
      !/^([-*+]|\d+\.)\s+/.test(lines[index].trim())) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    output.push(`<p>${paragraph.map(formatInline).join('<br>')}</p>`);
  }

  return output.join('');
}

function isMarkdownTable(headerLine, dividerLine) {
  if (!headerLine.includes('|')) {
    return false;
  }
  const headers = splitTableRow(headerLine);
  const dividers = splitTableRow(dividerLine);
  return headers.length > 0 && headers.length === dividers.length &&
    dividers.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableRow(line) {
  let value = line.trim();
  if (value.startsWith('|')) {
    value = value.slice(1);
  }
  if (value.endsWith('|') && !value.endsWith('\\|')) {
    value = value.slice(0, -1);
  }

  const cells = [];
  let cell = '';
  let escaped = false;
  for (const character of value) {
    if (character === '|' && !escaped) {
      cells.push(cell.trim().replace(/\\\|/g, '|'));
      cell = '';
      continue;
    }
    cell += character;
    if (character === '\\' && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  cells.push(cell.trim().replace(/\\\|/g, '|'));
  return cells;
}

function downloadTable(table, format) {
  const rows = Array.from(table.rows, (row) =>
    Array.from(row.cells, (cell) => cell.innerText.trim())
  );
  const fileNumber = table.dataset.tableNumber || '1';

  if (format === 'csv') {
    const csv = `\uFEFF${rows.map((row) =>
      row.map((cell) => {
        const safeCell = /^\s*[=+@]/.test(cell) || /^\s*-(?:\s|[A-Za-z=@])/.test(cell)
          ? `'${cell}`
          : cell;
        return `"${safeCell.replace(/"/g, '""')}"`;
      }).join(',')
    ).join('\r\n')}`;
    downloadBlob(csv, `dev-console-ai-table-${fileNumber}.csv`, 'text/csv;charset=utf-8');
    return;
  }

  if (format === 'xlsx') {
    const workbook = createXlsx(rows);
    downloadBlob(workbook, `dev-console-ai-table-${fileNumber}.xlsx`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return;
  }

  throw new Error('Unsupported table export format.');
}

function downloadBlob(content, filename, mimeType) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createXlsx(rows) {
  const xmlEscape = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  const columnName = (column) => {
    let name = '';
    for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
      name = String.fromCharCode(65 + (value - 1) % 26) + name;
    }
    return name;
  };
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) =>
      `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
    ).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');

  return createStoredZip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="AI Table" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>'],
    ['xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${sheetRows}</sheetData></worksheet>`]
  ]);
}

function createStoredZip(files) {
  const encoder = new TextEncoder();
  const entries = files.map(([name, content]) => {
    const filename = encoder.encode(name);
    const data = encoder.encode(content);
    return { filename, data, crc: crc32(data) };
  });
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  entries.forEach((entry) => {
    const localHeader = new Uint8Array(30 + entry.filename.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, entry.crc, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, entry.filename.length, true);
    localHeader.set(entry.filename, 30);
    localParts.push(localHeader, entry.data);

    const centralHeader = new Uint8Array(46 + entry.filename.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, entry.crc, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, entry.filename.length, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(entry.filename, 46);
    centralParts.push(centralHeader);
    localOffset += localHeader.length + entry.data.length;
  });

  const centralDirectory = concatenateBytes(centralParts);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, localOffset, true);
  return new Blob([...localParts, centralDirectory, endRecord], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

function concatenateBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  bytes.forEach((byte) => {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  });
  return (crc ^ 0xffffffff) >>> 0;
}

function formatInline(text) {
  let value = escapeHtml(text);
  value = value.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/\*(.+?)\*/g, '<em>$1</em>');
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
  value = value.replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return value;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
