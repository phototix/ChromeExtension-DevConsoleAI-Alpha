const storageKeys = {
  apiKey: 'devConsoleAiApiKey',
  model: 'devConsoleAiModel'
};

const apiKeyInput = document.getElementById('apiKeyInput');
const modelSelect = document.getElementById('modelSelect');
const saveButton = document.getElementById('saveSettingsBtn');
const status = document.getElementById('status');

document.getElementById('settingsForm').addEventListener('submit', saveSettings);
loadSettings();

function loadSettings() {
  chrome.storage.local.get([storageKeys.apiKey, storageKeys.model], (result) => {
    if (chrome.runtime.lastError) {
      showStatus(`Could not load settings: ${chrome.runtime.lastError.message}`, true);
      return;
    }

    apiKeyInput.value = result[storageKeys.apiKey] || '';
    modelSelect.value = result[storageKeys.model] || 'deepseek-chat';
  });
}

function saveSettings(event) {
  event.preventDefault();
  saveButton.disabled = true;
  status.textContent = '';
  status.className = '';

  chrome.storage.local.set({
    [storageKeys.apiKey]: apiKeyInput.value.trim(),
    [storageKeys.model]: modelSelect.value
  }, () => {
    saveButton.disabled = false;
    if (chrome.runtime.lastError) {
      showStatus(`Could not save settings: ${chrome.runtime.lastError.message}`, true);
      return;
    }

    showStatus('Settings saved.', false);
  });
}

function showStatus(message, isError) {
  status.textContent = message;
  status.className = isError ? 'error' : 'success';
}
