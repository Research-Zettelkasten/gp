(() => {
  'use strict';
  const stamp = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short'
  });
  let mounted = false;

  function mount({ client, getUser, onSaved }) {
    if (mounted) return;
    mounted = true;
    const dialog = document.createElement('dialog');
    dialog.id = 'gpLiveLunchDialog';
    dialog.className = 'gp-live-correction-dialog';
    dialog.setAttribute('aria-labelledby', 'gpLiveLunchTitle');
    dialog.innerHTML = `
      <form>
        <span class="gp-page-kicker">TIME &amp; ATTENDANCE</span>
        <h2 id="gpLiveLunchTitle">Correct live lunch punches</h2>
        <p>Update the lunch punches while the employee is still clocked in. The audit trail records the previous punches and your reason.</p>
        <strong id="gpLiveLunchEmployee"></strong>
        <p id="gpLiveLunchRecorded"></p>
        <fieldset class="gp-live-lunch-fields">
          <label for="gpLiveLunchMode">Lunch status</label>
          <select id="gpLiveLunchMode">
            <option value="complete">Lunch completed</option>
            <option value="open">Still on lunch</option>
            <option value="none">Clear recorded lunch</option>
          </select>
          <div id="gpLiveLunchOutField">
            <label for="gpLiveLunchOut">Lunch Out</label>
            <input id="gpLiveLunchOut" type="datetime-local">
          </div>
          <div id="gpLiveLunchBackField">
            <label for="gpLiveLunchBack">Lunch Back</label>
            <input id="gpLiveLunchBack" type="datetime-local">
          </div>
          <small class="gp-live-correction-timezone"></small>
          <label for="gpLiveLunchReason">Reason for correction</label>
          <textarea id="gpLiveLunchReason" rows="3" minlength="10" maxlength="1000" required
            placeholder="Explain how you verified the lunch punches."></textarea>
        </fieldset>
        <div class="gp-live-correction-preview" aria-live="polite"></div>
        <div class="gp-live-correction-status" role="status"></div>
        <div class="gp-clock-dialog-actions">
          <button type="button" id="gpLiveLunchCancel">Cancel</button>
          <button type="submit" id="gpLiveLunchApply" class="gp-live-correction-apply">Apply correction now</button>
        </div>
      </form>`;
    document.body.append(dialog);

    const form = dialog.querySelector('form');
    const fields = form.querySelector('fieldset');
    const mode = form.querySelector('#gpLiveLunchMode');
    const out = form.querySelector('#gpLiveLunchOut');
    const back = form.querySelector('#gpLiveLunchBack');
    const reason = form.querySelector('#gpLiveLunchReason');
    const status = form.querySelector('.gp-live-correction-status');
    const preview = form.querySelector('.gp-live-correction-preview');
    const cancel = form.querySelector('#gpLiveLunchCancel');
    const apply = form.querySelector('#gpLiveLunchApply');
    form.querySelector('.gp-live-correction-timezone').textContent =
      `Entries use ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Recorded punches are shown in Eastern time.`;

    let row = null;
    let busy = false;
    let revision = 0;
    let trigger;

    function originalOrEdited(input, original) {
      if (!input.value) return null;
      if (original && input.value === GP_CLOCK.localInput(Date.parse(original))) return original;
      const time = new Date(input.value);
      if (!Number.isFinite(+time)) throw Error('Enter a valid date and time for each lunch punch.');
      return time.toISOString();
    }

    function punches() {
      const lunchOut = mode.value === 'none' ? null : originalOrEdited(out, row.lunch_out_at);
      const lunchBack = mode.value === 'complete' ? originalOrEdited(back, row.lunch_in_at) : null;
      return { lunchOut, lunchBack };
    }

    function renderPreview() {
      const usesOut = mode.value !== 'none';
      const usesBack = mode.value === 'complete';
      out.parentElement.hidden = !usesOut;
      back.parentElement.hidden = !usesBack;
      out.required = usesOut;
      back.required = usesBack;
      if (!row) return;
      let corrected;
      try { corrected = punches(); }
      catch (error) { preview.textContent = error.message; return; }
      const { lunchOut, lunchBack } = corrected;
      if ((usesOut && !lunchOut) || (usesBack && !lunchBack)) {
        preview.textContent = usesBack ? 'Enter Lunch Out and Lunch Back to preview paid time.' : 'Enter Lunch Out to preview paid time.';
        return;
      }
      if (lunchBack && Math.floor(Date.parse(lunchBack) / 60000) <= Math.floor(Date.parse(lunchOut) / 60000)) {
        preview.textContent = 'Lunch Back must be at least one payroll minute after Lunch Out.';
        return;
      }
      const estimate = GP_CLOCK.preview({ ...row, lunch_out_at: lunchOut, lunch_in_at: lunchBack, break_minutes: 0 });
      const minutes = `${estimate.breakMinutes} unpaid lunch minutes${usesOut && !usesBack ? ' so far' : ''}`;
      const review = usesOut ? '' : ' A shift closed without lunch still requires lunch review.';
      preview.textContent = `${estimate.hours.toFixed(2)} estimated paid hours · ${minutes}.${review}`;
    }

    async function open(button) {
      if (busy || dialog.open || getUser()?.perm_admin !== true) return;
      const current = ++revision;
      trigger = button;
      row = null;
      form.reset();
      fields.disabled = true;
      apply.disabled = true;
      form.querySelector('#gpLiveLunchEmployee').textContent = '';
      form.querySelector('#gpLiveLunchRecorded').textContent = '';
      preview.textContent = '';
      status.textContent = 'Checking the active shift…';
      renderPreview();
      dialog.showModal();

      try {
        const active = await GP_CLOCK.readActive(client, button.dataset.correctLunchUser);
        if (current !== revision || !dialog.open) return;
        if (!active || Number(active.started_at_ms) !== Number(button.dataset.correctLunchStart)) {
          throw Error('This live shift changed or ended. Close this window and refresh.');
        }
        row = active;
        form.querySelector('#gpLiveLunchEmployee').textContent = row.employee_name;
        const recorded = [];
        if (row.lunch_out_at) recorded.push(`Lunch Out ${stamp.format(new Date(row.lunch_out_at))}`);
        if (row.lunch_in_at) recorded.push(`Lunch Back ${stamp.format(new Date(row.lunch_in_at))}`);
        if (recorded.length === 0 && row.break_minutes > 0) recorded.push(`${row.break_minutes} unpaid minutes without exact punches`);
        form.querySelector('#gpLiveLunchRecorded').textContent = recorded.length ? recorded.join(' · ') : 'No lunch recorded yet.';
        out.value = row.lunch_out_at ? GP_CLOCK.localInput(Date.parse(row.lunch_out_at)) : '';
        back.value = row.lunch_in_at ? GP_CLOCK.localInput(Date.parse(row.lunch_in_at)) : '';
        mode.value = row.lunch_out_at && !row.lunch_in_at ? 'open' : 'complete';
        fields.disabled = false;
        apply.disabled = false;
        status.textContent = '';
        renderPreview();
        mode.focus();
      } catch (error) {
        if (current === revision && dialog.open) status.textContent = error.message || 'Could not verify this active shift.';
      }
    }

    mode.addEventListener('change', renderPreview);
    out.addEventListener('input', renderPreview);
    back.addEventListener('input', renderPreview);
    cancel.onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      revision++;
      const focus = trigger?.isConnected ? trigger : [...document.querySelectorAll('[data-correct-lunch-user]')]
        .find(button => button.dataset.correctLunchUser === trigger?.dataset.correctLunchUser);
      focus?.focus();
    });
    form.onsubmit = async event => {
      event.preventDefault();
      if (busy || !row) return;
      const note = reason.value.trim();
      if (note.length < 10) {
        status.textContent = 'Enter an audit reason of at least 10 characters.';
        reason.focus();
        return;
      }
      busy = true;
      fields.disabled = apply.disabled = cancel.disabled = true;
      status.textContent = 'Saving correction and audit record…';

      let saved;
      try {
        const { lunchOut, lunchBack } = punches();
        const start = GP_TIME.effectiveStart(row);
        if (lunchOut && (Date.parse(lunchOut) < start || Date.parse(lunchOut) > Date.now())) {
          throw Error('Lunch Out must be within the active shift and cannot be in the future.');
        }
        if (lunchBack && (Date.parse(lunchBack) <= Date.parse(lunchOut) || Date.parse(lunchBack) > Date.now())) {
          throw Error('Lunch Back must be after Lunch Out and cannot be in the future.');
        }
        const { data, error } = await client.rpc('gp_admin_correct_live_lunch', {
          p_employee_id: row.auth_user_id,
          p_expected_start_ms: Number(row.started_at_ms),
          p_expected_approved_start: row.approved_clock_in_at ?? null,
          p_expected_lunch_out: row.lunch_out_at ?? null,
          p_expected_lunch_back: row.lunch_in_at ?? null,
          p_expected_break_minutes: row.break_minutes ?? null,
          p_lunch_out: lunchOut,
          p_lunch_back: lunchBack,
          p_reason: note
        });
        if (error) {
          throw Error(error.code === 'PGRST202' ? 'Run the administrator live lunch correction SQL update first.' : error.message);
        }
        if (data?.ok !== true) throw Error('The server did not confirm this correction. Reopen the shift and verify the punches.');
        saved = data;
      } catch (error) {
        status.textContent = error.message || 'The lunch correction was not saved.';
      } finally {
        busy = false;
        fields.disabled = apply.disabled = cancel.disabled = false;
      }
      if (saved) {
        dialog.close();
        onSaved?.(saved.unchanged ? 'Lunch punches already match.' : 'Lunch corrected. Live hours and the audit trail were updated.');
      }
    };

    document.addEventListener('click', event => {
      const button = event.target.closest('[data-correct-lunch-user]');
      if (button && !button.disabled) open(button);
    });
  }

  window.GP_ADMIN_LUNCH = Object.freeze({ mount });
})();
