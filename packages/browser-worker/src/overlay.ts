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
    en: { automation: 'TabReach is working here', paused: 'Paused', human: 'You are in control', pause: 'Pause', hint: 'Resume or take control in the TabReach app.' },
    ru: { automation: 'Здесь работает TabReach', paused: 'На паузе', human: 'Управляете вы', pause: 'Пауза', hint: 'Продолжить или взять управление — в приложении TabReach.' },
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
    const style = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;font:12px -apple-system,system-ui,sans-serif;background:#1f2430;color:#fff;border-radius:8px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;gap:8px;align-items:center;max-width:360px';
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
    sub.textContent = state.mode === 'automation' ? ((state.context && state.context.title) || '') : l.hint;
    text.appendChild(sub);
    box.appendChild(text);
    if (state.mode === 'automation') {
      const button = document.createElement('button');
      button.textContent = l.pause;
      button.setAttribute('style', 'all:initial;cursor:pointer;background:#fff;color:#1f2430;border-radius:6px;padding:4px 8px;font:600 12px -apple-system,system-ui,sans-serif');
      button.addEventListener('click', () => window.${OVERLAY_BINDING} && window.${OVERLAY_BINDING}('${PAUSE_REQUESTED}'));
      box.appendChild(button);
    }
    root.appendChild(box);
  };
  Object.defineProperty(window, '__tabreachOverlaySet', {
    value: (next) => { state = next; render(); },
    enumerable: false,
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();`;

/** Applies the current state to a page that already has the overlay script. */
export const overlaySetExpression = (state: OverlayState) =>
  `window.__tabreachOverlaySet && window.__tabreachOverlaySet(${JSON.stringify(state)})`;
