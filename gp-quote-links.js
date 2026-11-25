(() => {
  'use strict';
  const W = window.GP_WORKSPACE;
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  const date = value => new Date(value).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'America/New_York' });
  const kinds = { question: 'Customer question', answer: 'GLASSPRO reply', approval: 'Customer approval' };

  function replies(target, rows, options) {
    target.replaceChildren();
    for (const row of rows) {
      const item = W.element('li', null, 'gpw-item');
      item.append(W.element('strong', kinds[row.kind]), W.element('p', row.body));
      if (row.kind === 'approval') {
        const option = options[row.approved_option];
        item.append(W.element('p', option ? option.label + ' · ' + money(option.amount) : 'Approved option'));
      }
      item.append(W.element('div', date(row.created_at), 'gpw-muted'));
      target.append(item);
    }
  }

  function staff(client, quote) {
    const { panel } = W.dialog('Customer quote link', `
      <p>Quote <strong data-reference></strong>. Review the exact wording and totals before sharing.</p>
      <div class="gpw-actions"><button type="button" data-refresh>Refresh customer activity</button></div>
      <p class="gpw-status" role="status"></p>
      <div data-history></div>
      <form hidden>
        <div data-options></div>
        <div class="gpw-actions"><button type="button" data-add>Add option</button></div>
        <label>Expires in (days)<input type="number" name="days" min="1" max="30" value="14" required></label>
        <button class="gpw-primary">Publish link</button>
      </form>
      <div data-share hidden>
        <label>Customer link<input readonly></label>
        <div class="gpw-actions" data-share-actions></div>
      </div>`);
    const find = selector => panel.querySelector(selector);
    const message = find('[role=status]');
    const form = find('form');
    const options = find('[data-options]');
    let hasActive = false;
    function addOption(first = false) {
      if (options.children.length >= 3) return;
      const row = W.element('fieldset', null, 'gpw-item');
      row.innerHTML = `<div class="gpw-grid">
        <label>Option name<input name="label" required maxlength="80"></label>
        <label>Total with tax (USD)<input name="amount" type="number" required min="0" max="99999999.99" step="0.01"></label></div>
        <label>Description for customer<textarea name="description" rows="3" required maxlength="1500"></textarea></label>`;
      if (first) {
        row.querySelector('[name=label]').value = 'Quoted work';
        if (Number(quote.total) > 0) row.querySelector('[name=amount]').value = Number(quote.total).toFixed(2);
      } else {
        row.append(W.button('Remove this option', () => {
          row.remove();
          find('[data-add]').disabled = false;
        }));
      }
      options.append(row);
      find('[data-add]').disabled = options.children.length >= 3;
    }
    find('[data-reference]').textContent = '#' + quote.quote_number + ' · ' + quote.customer_name;
    find('[data-add]').onclick = () => addOption();
    addOption(true);

    async function load() {
      const rows = await W.rpc(client, 'gp_quote_link_staff', { p_quote: quote.quote_number });
      hasActive = rows.some(row => row.active);
      const history = find('[data-history]');
      history.replaceChildren();
      if (!rows.length) history.append(W.element('p', 'No links published for this quote.', 'gpw-muted'));
      for (const [index, row] of rows.entries()) {
        const item = W.element('details', null, 'gpw-item');
        item.open = index === 0;
        const title = row.active ? 'Active through ' : 'Inactive · expiration ';
        item.append(W.element('summary', title + date(row.expires_at)));
        const list = W.element('ul', null, 'gpw-list');
        replies(list, row.replies, row.options);
        item.append(list);
        if (!row.replies.length) item.append(W.element('p', 'No customer replies yet.', 'gpw-muted'));
        const photos = W.element('div', null, 'gpw-actions');
        row.photos.forEach((path, number) => {
          const view = W.button('View customer photo ' + (number + 1), () => W.action(view, message, async () => {
            const photo = W.element('img');
            photo.alt = 'Customer photo ' + (number + 1);
            photo.src = await W.signedPhoto(client, 'gp-quote-customer', path);
            const photoDialog = W.dialog('Customer photo', '');
            photoDialog.panel.append(photo);
          }));
          photos.append(view);
        });
        item.append(photos);
        if (row.active) {
          const answer = W.element('form');
          answer.innerHTML = '<label>Reply to customer<textarea required maxlength="1600" rows="2"></textarea></label><button>Post reply</button>';
          answer.onsubmit = event => {
            event.preventDefault();
            void W.action(answer.querySelector('button'), message, async () => {
              await W.rpc(client, 'gp_manage_quote_link', { p_link: row.id, p_action: 'answer', p_body: answer.querySelector('textarea').value });
              await load();
              W.status(message, 'Reply posted on the customer link.');
            });
          };
          const revoke = W.button('Revoke customer link', () => {
            if (!confirm('Revoke this link? The customer will lose access immediately.')) return;
            void W.action(revoke, message, async () => {
              await W.rpc(client, 'gp_manage_quote_link', { p_link: row.id, p_action: 'revoke' });
              find('[data-share]').hidden = true;
              await load();
              W.status(message, 'Customer access revoked.');
            });
          });
          item.append(answer, revoke);
        }
        history.append(item);
      }
      form.hidden = false;
    }
    const refresh = find('[data-refresh]');
    refresh.onclick = () => W.action(refresh, message, load);
    void refresh.onclick();
    form.onsubmit = event => {
      event.preventDefault();
      if (!confirm(hasActive
        ? 'Publish these options and revoke the current link? Existing customer replies will stay in the activity history.'
        : 'Publish these options and generate a private link for the customer?')) return;
      void W.action(form.querySelector('[type=submit],button:not([type])'), message, async () => {
        const payload = [...options.children].map(row => Object.fromEntries(
          [...row.querySelectorAll('input,textarea')].map(input => [input.name, input.value.trim()])));
        const token = await W.rpc(client, 'gp_publish_quote_link', {
          p_quote: quote.quote_number, p_options: payload, p_days: Number(form.elements.days.value)
        });
        const url = new URL('review-quote.html', location.href);
        url.hash = token;
        find('[data-share]').hidden = false;
        find('[data-share] input').value = url.href;
        const share = find('[data-share-actions]');
        const copy = W.button('Copy link', () => W.action(copy, message, async () => {
          await navigator.clipboard.writeText(url.href);
          W.status(message, 'Link copied.');
        }));
        const email = W.link('Open email draft', 'mailto:?subject=' + encodeURIComponent('GLASSPRO quote #' + quote.quote_number) +
          '&body=' + encodeURIComponent('Review your GLASSPRO quote: ' + url.href));
        share.replaceChildren(copy, email);
        await load();
        W.status(message, 'Link published. Copy it before closing this window.');
      });
    };
  }

  async function customer(client, token) {
    const find = selector => document.querySelector(selector);
    const message = find('[role=status]');
    const content = find('main');
    const approval = find('[data-approval]');
    const question = find('[data-question]');
    const photos = find('[data-photo]');
    const request = (p_action, extra) => W.rpc(client, 'gp_customer_quote', { p_token: token, p_action, ...extra });
    let reservedPath;
    function render(data) {
      if (!data) {
        content.hidden = true;
        W.status(message, 'This quote link is unavailable. Call GLASSPRO at (229) 244-8484 for help.', true);
        return false;
      }
      content.hidden = false;
      find('[data-heading]').textContent = 'Quote #' + data.quote_number;
      find('[data-caption]').textContent = [data.customer, 'Available through ' + date(data.expires_at)].join(' · ');
      const choices = find('[data-choices]');
      choices.replaceChildren();
      const select = approval.elements.option;
      const selected = select.value;
      select.replaceChildren(new Option('Choose an option', ''));
      data.options.forEach((option, index) => {
        const card = W.element('li', null, 'gpw-item');
        card.append(W.element('h3', option.label + ' · ' + money(option.amount)), W.element('p', option.description));
        choices.append(card);
        select.add(new Option(option.label + ' · ' + money(option.amount), index));
      });
      select.value = selected;
      const accepted = data.replies.find(row => row.kind === 'approval');
      approval.hidden = !!accepted;
      find('[data-confirmation]').textContent = accepted
        ? 'Approval received for ' + data.options[accepted.approved_option].label + '. GLASSPRO will contact you about scheduling.' : '';
      replies(find('[data-replies]'), data.replies, data.options);
      return true;
    }
    if (!/^[0-9a-f]{64}$/.test(token)) { render(null); return; }
    const refresh = find('[data-refresh]');
    refresh.onclick = () => W.action(refresh, message, async () => { render(await request('view')); });
    approval.onsubmit = event => {
      event.preventDefault();
      if (!confirm('Send this approval to GLASSPRO?')) return;
      void W.action(approval.querySelector('button'), message, async () => {
        if (render(await request('approve', { p_body: approval.elements.signer.value, p_option: Number(approval.elements.option.value) }))) {
          W.status(message, 'Your approval was sent.');
        }
      });
    };
    question.onsubmit = event => {
      event.preventDefault();
      void W.action(question.querySelector('button'), message, async () => {
        if (render(await request('question', { p_body: question.elements.question.value }))) {
          question.reset();
          W.status(message, 'Your question was sent.');
        }
      });
    };
    photos.onsubmit = event => {
      event.preventDefault();
      void W.action(photos.querySelector('button'), message, async () => {
        const file = await W.jpeg(photos.elements.photo.files[0]);
        const reservation = reservedPath ? { photo_path: reservedPath } : await request('photo');
        if (!reservation) { render(null); return; }
        reservedPath = reservation.photo_path;
        const { error } = await client.storage.from('gp-quote-customer').upload(reservedPath, file, { contentType: 'image/jpeg' });
        if (error) {
          if (String(error.statusCode) === '409') reservedPath = null;
          throw Error('Photo could not be uploaded. Refresh the link or try again.');
        }
        reservedPath = null;
        photos.reset();
        W.status(message, 'Your photo was sent.');
      });
    };
    await refresh.onclick();
  }

  window.GP_QUOTE_LINKS = { staff, customer };
})();
