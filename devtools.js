const storageKeys = {
  apiKey: 'devConsoleAiApiKey',
  model: 'devConsoleAiModel',
  chatHistory: 'devConsoleAiChatHistory'
};

const state = {
  activeSessionId: null,
  history: [],
  selectedContext: null,
  selectedContextType: 'none',
  contextCaptureId: 0,
  domPicker: null
};

window.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', () => stopDomPicker(false));

function init() {
  bindUi();
  loadHistory();
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
      return;
    }

    captureContext(state.selectedContextType);
  });
  document.getElementById('viewContextBtn').addEventListener('click', showContextDialog);
  document.getElementById('cancelDomPickBtn').addEventListener('click', () => stopDomPicker(true));
  document.getElementById('closeContextDialogBtn').addEventListener('click', () => {
    document.getElementById('contextDialog').close();
  });
  document.getElementById('contextDialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      event.currentTarget.close();
    }
  });

  document.getElementById('composer').addEventListener('submit', async (event) => {
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

    session.messages.push({ role: 'user', text: prompt });
    renderMessages();
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

      const answer = await askDeepSeek(prompt, contextText);
      session.messages.push({ role: 'assistant', text: answer });
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
  const activeSession = state.history.find((item) => item.id === state.activeSessionId);
  if (activeSession && activeSession.messages.length > 0) {
    activeSession.title = activeSession.messages[0].text.slice(0, 28) || 'New chat';
  }

  chrome.storage.local.set({
    [storageKeys.chatHistory]: state.history
  });
}

function renderHistory() {
  const historyList = document.getElementById('historyList');
  historyList.innerHTML = '';

  state.history.forEach((session) => {
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

    historyList.appendChild(button);
  });
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

async function captureContext(type = document.getElementById('contextType').value) {
  const contextTypeSelect = document.getElementById('contextType');
  if (type !== contextTypeSelect.value) {
    return null;
  }

  const captureId = ++state.contextCaptureId;
  try {
    if (type === 'none') {
      state.selectedContext = null;
      document.getElementById('viewContextBtn').disabled = true;
      setContextStatus('');
      return null;
    }

    state.selectedContext = null;
    document.getElementById('viewContextBtn').disabled = true;
    if (type === 'dom') {
      document.getElementById('cancelDomPickBtn').hidden = false;
      document.getElementById('sendBtn').disabled = true;
      setContextStatus('Hover over the page, then click an element. Press Esc to cancel.');
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
      setContextStatus('Selection cancelled');
      return null;
    }

    state.selectedContext = result;
    state.selectedContextType = type;
    document.getElementById('viewContextBtn').disabled = false;
    document.getElementById('cancelDomPickBtn').hidden = true;
    document.getElementById('sendBtn').disabled = false;
    setContextStatus('Attached');
    return result;
  } catch (error) {
    if (captureId === state.contextCaptureId && type === contextTypeSelect.value) {
      state.selectedContext = null;
      document.getElementById('viewContextBtn').disabled = true;
      document.getElementById('cancelDomPickBtn').hidden = true;
      document.getElementById('sendBtn').disabled = false;
      setContextStatus('Capture failed');
      document.getElementById('contextStatus').title = error.message;
    }
    return null;
  }
}

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
      chrome.devtools.inspectedWindow.eval(
        `(() => {
          if (!window.__devConsoleAiInjected) {
            const logs = [];
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
            };
            ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
              const original = console[level];
              console[level] = (...args) => {
                capture(level, args);
                return original.apply(console, args);
              };
            });
            window.__devConsoleAiLogs = logs;
            window.__devConsoleAiInjected = true;
          }
          return JSON.stringify(window.__devConsoleAiLogs || []);
        })()`,
        (result, exceptionInfo) => {
          if (exceptionInfo) {
            reject(new Error(exceptionInfo?.description || 'Console capture failed'));
            return;
          }
          const logs = parseJsonSafe(result);
          resolve(Array.isArray(logs) && logs.length > 0
            ? JSON.stringify(logs, null, 2)
            : 'No console logs captured yet.');
        }
      );
      return;
    }

    if (type === 'network') {
      chrome.devtools.network.getHAR((har) => {
        const entries = (har.entries || []).slice(0, 40).map((entry) => ({
          url: entry.request.url,
          method: entry.request.method,
          status: entry.response.status,
          type: entry._resourceType || entry.request.headers['Content-Type'] || 'unknown',
          size: entry.response.headersSize + entry.response.bodySize,
          time: entry.time
        }));
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
        const target = event.target;
        if (target === overlay || overlay.contains(target)) return null;
        return target instanceof Element ? target : target && target.parentElement;
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
        const parts = [];
        let current = element;
        while (current && current.nodeType === 1 && parts.length < 20) {
          let part = current.tagName.toLowerCase();
          const siblings = current.parentElement
            ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current.tagName)
            : [];
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          parts.unshift(part);
          current = current.parentElement;
        }
        const html = element.outerHTML;
        const maxHtmlLength = 30000;
        picker.result = JSON.stringify({
          selector: parts.join(' > '),
          tagName: element.tagName.toLowerCase(),
          id: element.id || null,
          classes: Array.from(element.classList),
          text: (element.innerText || element.textContent || '').trim().slice(0, 1000),
          outerHTML: html.slice(0, maxHtmlLength),
          truncated: html.length > maxHtmlLength
        });
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

async function askDeepSeek(prompt, contextText) {
  const settings = await new Promise((resolve, reject) => {
    chrome.storage.local.get([storageKeys.apiKey, storageKeys.model], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`Could not load API settings: ${chrome.runtime.lastError.message}`));
        return;
      }
      resolve(result);
    });
  });
  const apiKey = settings[storageKeys.apiKey] || '';
  const model = settings[storageKeys.model] || 'deepseek-chat';

  if (!apiKey) {
    return 'Missing DeepSeek API key. Click the extension icon in the Chrome toolbar to configure it.';
  }

  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: 'You are a helpful frontend debugging assistant. Use the provided page context to answer the user accurately and concisely.'
      },
      {
        role: 'user',
        content: contextText ? `${prompt}\n\n--- ATTACHED CONTEXT ---\n${contextText}` : prompt
      }
    ],
    temperature: 0.2,
    stream: false
  };

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`DeepSeek request failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || 'No response returned by DeepSeek.';
}

function renderMarkdown(markdown) {
  if (!markdown) {
    return '<p class="empty-state">No content.</p>';
  }

  const escaped = escapeHtml(markdown);
  const codeBlocks = [];
  const withCodeBlocks = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
    const token = `__CODEBLOCK_${codeBlocks.length}__`;
    codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return token;
  });

  const paragraphs = withCodeBlocks
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (block.startsWith('__CODEBLOCK_')) {
        const index = Number(block.replace(/[^\d]/g, ''));
        return codeBlocks[index] || '';
      }

      const lines = block.split(/\n/);
      const items = [];
      const isList = lines.every((line) => /^[-*] /.test(line) || /^\d+\. /.test(line));

      if (isList) {
        const listType = lines[0].match(/^\d+\./) ? 'ol' : 'ul';
        const htmlItems = lines
          .map((line) => line.replace(/^[-*]\s+|^\d+\.\s+/, ''))
          .map((item) => `<li>${formatInline(item)}</li>`)
          .join('');
        return `<${listType}>${htmlItems}</${listType}>`;
      }

      if (block.startsWith('#')) {
        const level = block.match(/^#+/)?.[0].length || 1;
        const content = formatInline(block.replace(/^#+\s*/, ''));
        return `<h${level}>${content}</h${level}>`;
      }

      const paragraphs = block
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `<p>${formatInline(line)}</p>`)
        .join('');
      return paragraphs;
    })
    .join('');

  return paragraphs;
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
