/* global window, document, location */
// A minimal LinkedIn-like profile for adapter tests (Phase 7). Own markup — nothing copied —
// with the roles and names the linkedin pack recognizes. Every invitation and message sent is
// counted in localStorage (`li_actions`) so tests can prove an action happened once.
// ?thread=replied: the person answered after our last message. ?result=silent: nothing confirms.
(() => {
  const p = window.LI;
  const q = new URLSearchParams(location.search);
  const record = (action) => {
    const all = JSON.parse(localStorage.getItem('li_actions') ?? '[]');
    all.push(action);
    localStorage.setItem('li_actions', JSON.stringify(all));
  };
  const el = (tag, attrs = {}, text = '') => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text) e.textContent = text;
    return e;
  };
  const main = el('main');
  main.append(el('h1', {}, p.name), el('p', {}, p.headline));
  const actions = el('div', { role: 'group', 'aria-label': 'Profile actions' });
  main.append(actions);
  const status = el('p', { role: 'status' });
  main.append(status);
  document.body.append(el('nav', { 'aria-label': 'Primary' }, 'Home Network Messaging'), main);

  const pending = () => {
    actions.replaceChildren(el('button', { type: 'button' }, 'Pending'));
  };
  if (p.degree === 'pending') pending();
  if (p.degree === '2nd') {
    const connect = el('button', { type: 'button' }, 'Connect');
    actions.append(connect, el('button', { type: 'button' }, 'More'));
    connect.onclick = () => {
      const dlg = el('div', { role: 'dialog', 'aria-label': `Invite ${p.name} to connect` });
      dlg.append(el('h2', {}, 'Add a note to your invitation?'));
      const addNote = el('button', { type: 'button' }, 'Add a note');
      const without = el('button', { type: 'button' }, 'Send without a note');
      dlg.append(addNote, without);
      const sent = (note) => {
        record({ type: 'invite', profile: location.pathname, note });
        dlg.remove();
        pending();
        if (q.get('result') !== 'silent') status.textContent = 'Invitation sent';
      };
      without.onclick = () => sent('');
      addNote.onclick = () => {
        dlg.replaceChildren(el('h2', {}, 'Add a note to your invitation'));
        const note = el('textarea', { 'aria-label': 'Add a note' });
        const send = el('button', { type: 'button' }, 'Send');
        send.onclick = () => sent(note.value);
        dlg.append(note, send);
      };
      document.body.append(dlg);
    };
  }
  if (p.degree === '1st') {
    const message = el('button', { type: 'button' }, 'Message');
    actions.append(message, el('button', { type: 'button' }, 'More'));
    message.onclick = () => {
      const dlg = el('div', { role: 'dialog', 'aria-label': 'Messaging' });
      const list = el('ul', { 'aria-label': 'Conversation' });
      const item = (from, text) => list.append(el('li', { 'aria-label': `Message from ${from}` }, text));
      item('you', 'Hello, nice to meet you.');
      if (q.get('thread') === 'replied') item(p.name, 'Thanks, tell me more.');
      const box = el('textarea', { 'aria-label': 'Write a message' });
      const send = el('button', { type: 'button' }, 'Send');
      const sentNote = el('p', { role: 'status' });
      send.onclick = () => {
        record({ type: 'message', profile: location.pathname, body: box.value });
        item('you', box.value);
        box.value = '';
        if (q.get('result') !== 'silent') sentNote.textContent = 'Message sent';
      };
      dlg.append(el('h2', {}, p.name), list, box, send, sentNote);
      document.body.append(dlg);
    };
  }
})();
