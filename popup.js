const storageKeys = {
  apiKey: 'devConsoleAiApiKey',
  model: 'devConsoleAiModel',
  theme: 'devConsoleAiTheme'
};

const apiKeyInput = document.getElementById('apiKeyInput');
const modelSelect = document.getElementById('modelSelect');
const themeSelect = document.getElementById('themeSelect');
const saveButton = document.getElementById('saveSettingsBtn');
const status = document.getElementById('status');

document.getElementById('settingsForm').addEventListener('submit', saveSettings);
themeSelect.addEventListener('change', () => applyPopupTheme(themeSelect.value));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeSelect.value === 'system') {
    applyPopupTheme('system');
  }
});
loadSettings();

function loadSettings() {
  chrome.storage.local.get([storageKeys.apiKey, storageKeys.model, storageKeys.theme], (result) => {
    if (chrome.runtime.lastError) {
      showStatus(`Could not load settings: ${chrome.runtime.lastError.message}`, true);
      return;
    }

    apiKeyInput.value = result[storageKeys.apiKey] || '';
    modelSelect.value = result[storageKeys.model] || 'deepseek-chat';
    const theme = result[storageKeys.theme];
    themeSelect.value = ['dark', 'light', 'system'].includes(theme) ? theme : 'dark';
    applyPopupTheme(themeSelect.value);
  });
}

function saveSettings(event) {
  event.preventDefault();
  saveButton.disabled = true;
  status.textContent = '';
  status.className = '';

  chrome.storage.local.set({
    [storageKeys.apiKey]: apiKeyInput.value.trim(),
    [storageKeys.model]: modelSelect.value,
    [storageKeys.theme]: themeSelect.value
  }, () => {
    saveButton.disabled = false;
    if (chrome.runtime.lastError) {
      showStatus(`Could not save settings: ${chrome.runtime.lastError.message}`, true);
      return;
    }

    applyPopupTheme(themeSelect.value);
    showStatus('Settings saved.', false);
  });
}

function applyPopupTheme(preference) {
  const validPreference = ['dark', 'light', 'system'].includes(preference) ? preference : 'dark';
  const isDark = validPreference === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : validPreference === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
}

function showStatus(message, isError) {
  status.textContent = message;
  status.className = isError ? 'error' : 'success';
}
