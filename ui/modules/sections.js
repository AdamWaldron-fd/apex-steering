export function toggleSection(titleEl) {
  const body = titleEl.nextElementSibling;
  const toggle = titleEl.querySelector('.toggle');
  if (body.classList.contains('collapsed')) {
    body.classList.remove('collapsed');
    toggle.textContent = '[-]';
  } else {
    body.classList.add('collapsed');
    toggle.textContent = '[+]';
  }
}
