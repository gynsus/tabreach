/* global window, document, location */
// A minimal LinkedIn-like profile for adapter tests (Phase 7). Own markup — nothing copied —
// with the roles and names the linkedin pack recognizes, shaped like the live check of
// 2026-09-30: the name is a level-2 heading in main, a sidebar of other people outside main has
// Connect buttons, "Message" is a link to the conversation's own page (messaging/compose/), where
// the conversation is an unnamed list whose first item of a group names the sender by links and
// a floating chat window outside main has a composer of its own. Every invitation and message sent is
// counted in localStorage (`li_actions`) so tests can prove an action happened once.
// ?thread=replied: the person answered after our last message; ?thread=none: no conversation yet;
// ?thread=unreadable: messages without sender links. ?result=silent: nothing confirms.
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
  if (p.page === 'messaging') main.append(el('h1', {}, 'Messaging'));
  else main.append(el('h2', {}, p.name), el('p', {}, p.headline), el('h2', {}, 'About'));
  const actions = el('div', { role: 'group', 'aria-label': 'Profile actions' });
  main.append(actions);
  const status = el('p', { role: 'status' });
  main.append(status);
  // Like the real site, the header has a heading of its own before the profile's.
  const header = el('header');
  header.append(
    el('h2', {}, 'Notifications'),
    el('nav', { 'aria-label': 'Primary' }, 'Home Network Messaging'),
  );
  document.body.append(header, main);

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
    // Like the real link: the conversation's own page, naming the recipient (here by slug and name).
    const to = new URLSearchParams(q);
    to.set('recipient', location.pathname.split('/').filter(Boolean).pop());
    to.set('name', p.name);
    const message = el('a', { href: `../../messaging/compose/?${to}` }, 'Message');
    actions.append(message, el('button', { type: 'button' }, 'More'));
    // A click is not what the pack does: it opens a floating window, like the real site sometimes.
    message.onclick = (event) => {
      event.preventDefault();
      document.body.append(el('aside', { 'aria-label': 'Chat' }, 'Floating chat'));
    };
  }
  if (p.page === 'messaging') {
    const name = q.get('name') ?? '';
    const list = el('ul');
    let lastSender = null;
    const item = (sender, text) => {
      const li = el('li');
      if (sender !== lastSender && q.get('thread') !== 'unreadable') {
        const first = sender.split(' ')[0];
        li.append(el('a', { href: '#' }, `View ${first}’s profile`), el('a', { href: '#' }, sender));
        lastSender = sender;
      }
      li.append(el('p', {}, text));
      list.append(li);
    };
    const none = q.get('thread') === 'none';
    if (!none) {
      list.append(el('li', {}, 'Jul 3, 2025'));
      item('Sam Sender', 'Hello, nice to meet you.');
    }
    if (q.get('thread') === 'replied') item(name, 'Thanks, tell me more.');
    // Other conversations: names, but no profile links.
    const others = el('ul', { 'aria-label': 'Conversations' });
    for (const who of ['Old Friend', 'Former Colleague', ...(none ? [] : [name])]) {
      const li = el('li');
      li.append(el('a', { href: '#' }, who));
      others.append(li);
    }
    const box = el('textarea', { 'aria-label': 'Write a message…' });
    const send = el('button', { type: 'button' }, 'Send');
    send.onclick = () => {
      record({ type: 'message', profile: `/li/in/${q.get('recipient')}/`, body: box.value });
      if (q.get('result') !== 'silent') item('Sam Sender', box.value);
      box.value = '';
    };
    main.replaceChildren(
      el('h1', {}, 'Messaging'),
      others,
      el('h2', {}, name),
      list,
      box,
      send,
      el('button', { type: 'button' }, 'Open send options'),
    );
  }
  if (p.page !== 'messaging') {
    // Outside main, like the real sidebar: other people, with buttons of their own.
    const aside = el('aside', { 'aria-label': 'More profiles for you' });
    aside.append(el('a', { href: '#' }, 'Dana Other'), el('button', { type: 'button' }, 'Connect'));
    document.body.append(aside);
  } else {
    // A floating chat window left open on another page: a composer of its own, outside main.
    const chat = el('aside', { 'aria-label': 'Chat' });
    chat.append(
      el('textarea', { 'aria-label': 'Write a message…' }),
      el('button', { type: 'button' }, 'Send'),
    );
    document.body.append(chat);
  }
})();
