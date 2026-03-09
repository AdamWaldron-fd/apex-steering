export const $ = (id) => document.getElementById(id);

export function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function logSteering(msg, type = 'info') {
  const el = $('steering-log');
  const ts = new Date().toLocaleTimeString();
  el.innerHTML =
    `<div class="ev"><span class="ev-time">[${ts}]</span> <span class="ev-${type}">${escHtml(msg)}</span></div>` +
    el.innerHTML;
}

export function logEvent(msg, type = 'info') {
  logSteering(msg, type);
}
