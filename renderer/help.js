'use strict';

(function () {
  function applyTheme(config) {
    const value = config?.settings?.theme || config?.theme || 'light';
    document.documentElement.dataset.theme = value;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    await copyText(source.textContent);
    button.textContent = 'Copied';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = 'Copy';
      button.classList.remove('copied');
    }, 1200);
  });

  const sections = [...document.querySelectorAll('main section[id]')];
  const links = [...document.querySelectorAll('.help-nav a[href^="#"]')];
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      for (const link of links) {
        link.classList.toggle('active', link.hash === `#${visible.target.id}`);
      }
    },
    { rootMargin: '-90px 0px -65% 0px', threshold: 0 }
  );
  sections.forEach((section) => observer.observe(section));

  window.smartnet.onConfigChanged(applyTheme);
  window.smartnet.getConfig().then(applyTheme);
})();
