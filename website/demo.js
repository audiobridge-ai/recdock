'use strict';
// Illustration only: no recording, upload, analytics, or external requests.
for (const button of document.querySelectorAll('.segment')) {
  button.addEventListener('click', () => {
    for (const row of document.querySelectorAll('.segment')) {
      const active = row === button;
      row.classList.toggle('active', active); row.setAttribute('aria-pressed', String(active));
    }
    document.querySelector('#demo-time').textContent = button.dataset.at === '7' ? '00:07' : '00:00';
  });
}
