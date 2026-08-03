'use strict';

(async function () {
  const form = document.getElementById('config-form');
  const hostInput = document.getElementById('config-host');
  const portInput = document.getElementById('config-port');
  const hint = document.getElementById('network-hint');
  const error = document.getElementById('config-error');
  const cancel = document.getElementById('config-cancel');

  function selectedTheme() {
    return document.querySelector('input[name="theme"]:checked')?.value || 'light';
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  }

  for (const radio of document.querySelectorAll('input[name="theme"]')) {
    radio.addEventListener('change', () => applyTheme(selectedTheme()));
  }

  cancel.addEventListener('click', () => window.smartnet.closeConfig());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';

    const host = hostInput.value.trim();
    const port = Number(portInput.value);
    if (!host || /\s|\//.test(host) || host.includes('://')) {
      error.textContent = 'Enter a hostname or IP address without a protocol or port.';
      hostInput.focus();
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      error.textContent = 'Port must be between 1 and 65535.';
      portInput.focus();
      return;
    }

    const result = await window.smartnet.saveConfig({
      host,
      port,
      theme: selectedTheme(),
    });
    if (!result.ok) {
      error.textContent = result.error || 'Could not save configuration.';
      return;
    }
    await window.smartnet.closeConfig();
  });

  try {
    const result = await window.smartnet.getConfig();
    if (!result.ok) throw new Error(result.error || 'Could not load configuration.');

    hostInput.value = result.settings.host;
    portInput.value = String(result.settings.port);
    const themeRadio = document.querySelector(
      `input[name="theme"][value="${result.settings.theme}"]`
    );
    if (themeRadio) themeRadio.checked = true;
    applyTheme(result.settings.theme);

    if (result.proxyRunning) {
      hostInput.disabled = true;
      portInput.disabled = true;
      hint.textContent = 'Host and port are locked while the proxy is running. Theme can still be changed.';
      hint.classList.add('warning');
    }
  } catch (err) {
    error.textContent = err.message || String(err);
  }
})();
