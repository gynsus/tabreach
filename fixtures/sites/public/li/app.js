/* global window, document, location */
// A minimal LinkedIn-like profile for adapter tests (Phase 7). Own markup — nothing copied —
// with the roles and names the linkedin pack recognizes, shaped like the live check of
// 2026-09-30: the name is a level-2 heading, "Message" is a link opening a "Messaging" dialog,
// the conversation is an unnamed list whose first item of a group names the sender by links. Every invitation and message sent is
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
  main.append(el('h2', {}, p.name), el('p', {}, p.headline), el('h2', {}, 'About'));
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
    const message = el('a', { href: '#compose' }, 'Message');
    actions.append(message, el('button', { type: 'button' }, 'More'));
    message.onclick = (event) => {
      event.preventDefault();
      if (document.querySelector('[aria-label="Messaging"]')) return;
      const dlg = el('div', { role: 'dialog', 'aria-label': 'Messaging' });
      const list = el('ul');
      let lastSender = null;
      const item = (sender, text) => {
        const li = el('li');
        if (sender !== lastSender) {
          const first = sender.split(' ')[0];
          li.append(el('a', { href: '#' }, `View ${first}’s profile`), el('a', { href: '#' }, sender));
          lastSender = sender;
        }
        li.append(el('p', {}, text));
        list.append(li);
      };
      list.append(el('li', {}, 'Jul 3, 2025'));
      item('Sam Sender', 'Hello, nice to meet you.');
      if (q.get('thread') === 'replied') item(p.name, 'Thanks, tell me more.');
      const box = el('textarea', { 'aria-label': 'Write a message…' });
      const send = el('button', { type: 'button' }, 'Send');
      send.onclick = () => {
        record({ type: 'message', profile: location.pathname, body: box.value });
        if (q.get('result') !== 'silent') item('Sam Sender', box.value);
        box.value = '';
      };
      dlg.append(el('h2', {}, p.name), list, box, send, el('button', { type: 'button' }, 'Open send options'));
      document.body.append(dlg);
    };
  }
})();
