/* global window, document, location */
// A minimal LinkedIn-like profile for adapter tests (Phase 7). Own markup — nothing copied —
// with the roles and names the linkedin pack recognizes, shaped like the live checks of
// 2026-09-30 and 2026-10-09: the name is a level-2 heading in main; a sidebar of other people
// (an aside inside main) has Connect and Message of its own; "Connect" is a link named "Invite
// <name> to connect" to the invitation's own page (preload/custom-invite/) and "Message" a link to
// the conversation's own page (messaging/compose/) — clicks on either do nothing; the conversation
// is an unnamed list whose first item of a group names the sender by links, the composer an
// editable div, and a floating chat window outside main has a composer of its own. Every
// invitation and message sent is
// counted in localStorage (`li_actions`) so tests can prove an action happened once.
// ?thread=replied: the person answered after our last message; ?thread=none: no conversation yet;
// ?thread=unreadable: messages without sender links; ?thread=older: older messages load later. ?result=silent: nothing confirms.
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
  if (p.page === 'invite') {
    // The invitation's own page: a dialog, no main.
  } else if (p.page === 'messaging') main.append(el('h1', {}, 'Messaging'));
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
  document.body.append(header);
  if (p.page !== 'invite') document.body.append(main);

  const pending = () => {
    actions.replaceChildren(el('button', { type: 'button' }, 'Pending'));
  };
  if (p.degree === 'pending') pending();
  if (p.degree === '2nd') {
    // Like the real link: "Invite <name> to connect", to the invitation's own page; a click on
    // it does nothing (the pack follows it).
    const to = new URLSearchParams(q);
    to.set('vanityName', location.pathname.split('/').filter(Boolean).pop());
    to.set('name', p.name);
    const connect = el(
      'a',
      { href: `../../preload/custom-invite/?${to}`, 'aria-label': `Invite ${p.name} to connect` },
      'Connect',
    );
    connect.onclick = (event) => event.preventDefault();
    actions.append(connect, el('button', { type: 'button' }, 'More'));
  }
  if (p.page === 'invite') {
    const dlg = el('div', { role: 'dialog', 'aria-labelledby': 'invite-title' });
    const title = el('h2', { id: 'invite-title' }, 'Add a note to your invitation?');
    const addNote = el('button', { type: 'button' }, 'Add a note');
    const without = el('button', { type: 'button' }, 'Send without a note');
    dlg.append(el('button', { type: 'button', 'aria-label': 'Dismiss' }), title, addNote, without);
    const sent = (note) => {
      record({ type: 'invite', profile: `/li/in/${q.get('vanityName')}/`, note });
      dlg.remove();
      if (q.get('result') !== 'silent') document.body.append(el('div', { role: 'alert' }, 'Invitation sent'));
    };
    without.onclick = () => sent('');
    addNote.onclick = () => {
      title.textContent = 'Add a note to your invitation';
      const label = el('label', { for: 'note' }, 'Please limit personal note to 300 characters');
      const note = el('textarea', { id: 'note', placeholder: 'Ex: We know each other from…' });
      const send = el('button', { type: 'button', 'aria-label': 'Send invitation' }, 'Send');
      send.onclick = () => sent(note.value);
      dlg.replaceChildren(title, label, note, el('button', { type: 'button' }, 'Cancel'), send);
    };
    document.body.append(dlg);
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
    if (q.get('thread') === 'older') {
      // Like the real thread: older messages of ours load in at the top a moment later.
      setTimeout(() => {
        const older = el('li');
        older.append(el('a', { href: '#' }, 'View Sam’s profile'), el('a', { href: '#' }, 'Sam Sender'));
        older.append(el('p', {}, 'An older message.'));
        list.prepend(older);
      }, 3_000);
    }
    // Other conversations: names, but no profile links.
    const others = el('ul', { 'aria-label': 'Conversations' });
    for (const who of ['Old Friend', 'Former Colleague', ...(none ? [] : [name])]) {
      const li = el('li');
      li.append(el('a', { href: '#' }, who));
      others.append(li);
    }
    // Like the real composer: an editable div, not a field.
    const box = el('div', {
      role: 'textbox',
      contenteditable: 'true',
      'aria-multiline': 'true',
      'aria-label': 'Write a message…',
    });
    const send = el('button', { type: 'button' }, 'Send');
    send.onclick = () => {
      record({ type: 'message', profile: `/li/in/${q.get('recipient')}/`, body: box.innerText });
      if (q.get('result') !== 'silent') item('Sam Sender', box.innerText);
      box.textContent = '';
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
  if (p.page === undefined) {
    // Inside main, like the real sidebar: other people, with links and buttons of their own.
    const aside = el('aside', { 'aria-label': 'More profiles for you' });
    aside.append(
      el('a', { href: '#' }, 'Dana Other'),
      el('a', { href: '#', 'aria-label': 'Invite Dana Other to connect' }, 'Connect'),
      el('button', { type: 'button' }, 'Connect'),
      el('a', { href: '#' }, 'Message'),
    );
    main.append(aside);
  } else if (p.page === 'messaging') {
    // A floating chat window left open on another page: a composer of its own, outside main.
    const chat = el('aside', { 'aria-label': 'Chat' });
    chat.append(
      el('textarea', { 'aria-label': 'Write a message…' }),
      el('button', { type: 'button' }, 'Send'),
    );
    document.body.append(chat);
  }
})();
