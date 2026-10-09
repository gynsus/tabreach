import type { ControlMode, OverlayContext } from '@tabreach/protocol';

/** The one message a page may send to the worker (docs/12 "Trust boundary"). */
export const PAUSE_REQUESTED = 'pause_requested';
export const OVERLAY_BINDING = '__tabreachOverlay';

export interface OverlayState {
  mode: ControlMode;
  context: OverlayContext | null;
}

/**
 * The in-page overlay (docs/12, ADR 014), injected into every page of an automation-owned session.
 * It lives in a closed shadow root with its own styles, says what TabReach is doing and who is in
 * control, and offers one action: Pause. Anything the page itself could do through the binding is
 * therefore only a pause. It is explanatory: nothing depends on it being present.
 */
export const OVERLAY_SCRIPT = `(() => {
  if (window.top !== window || window.__tabreachOverlayInstalled) return;
  window.__tabreachOverlayInstalled = true;
  const labels = {
    en: { automation: 'TabReach is working here', paused: 'Paused', human: 'You are in control', pause: 'Pause', hint: 'Resume or take control in the TabReach app.', copy: 'Copy', copied: 'Copied' },
    ru: { automation: 'Здесь работает TabReach', paused: 'На паузе', human: 'Управляете вы', pause: 'Пауза', hint: 'Продолжить или взять управление — в приложении TabReach.', copy: 'Копировать', copied: 'Скопировано' },
  };
  let state = { mode: 'paused', context: null };
  let host = null;
  let root = null;
  const render = () => {
    if (!document.documentElement) return;
    if (!host || !host.isConnected) {
      host = document.createElement('tabreach-overlay');
      root = host.attachShadow({ mode: 'closed' });
      document.documentElement.appendChild(host);
    }
    host.setAttribute('data-tabreach-mode', state.mode);
    const l = labels[(state.context && state.context.lang) || 'en'];
    const style = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;font:12px -apple-system,system-ui,sans-serif;background:#1f2430;color:#fff;border-radius:8px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:360px';
    const content = state.context && state.context.content;
    root.innerHTML = '';
    const box = document.createElement('div');
    box.setAttribute('style', style);
    const text = document.createElement('div');
    const strong = document.createElement('div');
    strong.textContent = l[state.mode] || l.paused;
    strong.setAttribute('style', 'font-weight:600');
    text.appendChild(strong);
    const sub = document.createElement('div');
    sub.setAttribute('style', 'opacity:.8');
    sub.textContent = state.mode === 'automation' || content ? ((state.context && state.context.title) || '') : l.hint;
    text.appendChild(sub);
    if ((state.mode === 'automation' || content) && state.context && state.context.detail) {
      const detail = document.createElement('div');
      detail.setAttribute('style', 'opacity:.7');
      detail.textContent = state.context.detail;
      text.appendChild(detail);
    }
    box.appendChild(text);
    if (state.mode === 'automation') {
      const button = document.createElement('button');
      button.textContent = l.pause;
      button.setAttribute('style', 'all:initial;cursor:pointer;background:#fff;color:#1f2430;border-radius:6px;padding:4px 8px;font:600 12px -apple-system,system-ui,sans-serif');
      button.addEventListener('click', () => window.${OVERLAY_BINDING} && window.${OVERLAY_BINDING}('${PAUSE_REQUESTED}'));
      box.appendChild(button);
    }
    if (content) {
      // Manual mode (docs/09): the prepared text, to copy; the overlay never types it anywhere.
      const area = document.createElement('textarea');
      area.readOnly = true;
      area.value = content;
      area.setAttribute('style', 'all:initial;box-sizing:border-box;width:100%;height:96px;background:#fff;color:#1f2430;border-radius:6px;padding:6px;font:12px -apple-system,system-ui,sans-serif;white-space:pre-wrap;overflow:auto');
      const copy = document.createElement('button');
      copy.textContent = l.copy;
      copy.setAttribute('style', 'all:initial;cursor:pointer;background:#fff;color:#1f2430;border-radius:6px;padding:4px 8px;font:600 12px -apple-system,system-ui,sans-serif');
      const done = () => { copy.textContent = l.copied; };
      copy.addEventListener('click', () => {
        const fallback = () => { area.select(); try { if (document.execCommand('copy')) done(); } catch (e) { /* the text stays selected to copy by hand */ } };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(content).then(done, fallback);
        else fallback();
      });
      box.appendChild(area);
      box.appendChild(copy);
    }
    root.appendChild(box);
  };
  Object.defineProperty(window, '__tabreachOverlaySet', {
    value: (next) => { state = next; render(); },
    enumerable: false,
  });
  const start = () => {
    render();
    // A page that removes the overlay gets it back (docs/12 "Limitations accepted").
    new MutationObserver(() => { if (host && !host.isConnected) render(); })
      .observe(document.documentElement, { childList: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;

/** Applies the current state to a page that already has the overlay script. */
export const overlaySetExpression = (state: OverlayState) =>
  `window.__tabreachOverlaySet && window.__tabreachOverlaySet(${JSON.stringify(state)})`;

/**
 * What a page is shown: the prepared text (`manual` mode) only on pages of the site it is meant
 * for — any page can read the overlay (docs/12, ADR 015).
 */
export function overlayContextFor(context: OverlayContext | null, pageUrl: string): OverlayContext | null {
  if (!context?.content) return context;
  const origin = URL.canParse(pageUrl) ? new URL(pageUrl).origin : null;
  const own = context.contentOrigin !== null && origin === new URL(context.contentOrigin).origin;
  return own ? context : { ...context, content: null };
}
