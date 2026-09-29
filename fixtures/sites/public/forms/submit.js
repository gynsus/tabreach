/* global window, location, document */
// Shared by the form fixtures (Phase 6): counts every submission in localStorage so tests can
// prove a form was sent once, and shows the site's reaction chosen by ?result=:
// thanks (default: a thank-you page), inline (a message on the same page), reject (validation
// errors on the form), silent (nothing visible).
window.fixtureSubmit = (form, event) => {
  event.preventDefault();
  const result = new URLSearchParams(location.search).get('result') ?? 'thanks';
  const sent = JSON.parse(localStorage.getItem('fixture_submissions') ?? '[]');
  const values = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    values[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  sent.push({ page: location.pathname, values });
  localStorage.setItem('fixture_submissions', JSON.stringify(sent));
  if (result === 'reject') {
    const email = form.querySelector('[type=email]');
    if (email) email.setAttribute('aria-invalid', 'true');
    const error = document.createElement('p');
    error.setAttribute('role', 'alert');
    error.textContent = 'Please correct the highlighted fields.';
    form.append(error);
  } else if (result === 'inline') {
    const done = document.createElement('p');
    done.setAttribute('role', 'status');
    done.textContent = 'Thank you! Your message has been sent.';
    form.replaceWith(done);
  } else if (result === 'thanks') {
    location.href = new URL('thanks.html', location.href).href;
  }
};
