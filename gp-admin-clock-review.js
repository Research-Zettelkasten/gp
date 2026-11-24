/* Persistent review queue for automatic or ambiguous missed clock-outs. */
(() => {
  'use strict';
  let config, busy = false, rows = [], fingerprint = '', loadError = false;
  const get = id => document.getElementById(id);
  const esc = value => GP.escapeHtml(value);
  const stamp = value => value ? new Date(value).toLocaleString('en-US', {
    timeZone:'America/New_York', dateStyle:'medium', timeStyle:'short'
  }) : 'Not recorded';

  function reviewCard(row) {
    const snapshot = row.session_snapshot;
    return `
      <article class="gp-auto-review" data-review="${row.id}">
        <strong>${esc(row.employee_name)}</strong> · ${row.emergency ? 'Emergency cutoff' : 'Missed daily cutoff'}<br>
        Clocked in ${esc(stamp(snapshot.effective_started_at || snapshot.started_at))}<br>
        Scheduled check ${esc(stamp(row.due_at))} · Default end ${esc(stamp(row.default_ended_at))}
        <p>${esc(row.reason)}</p>
        <details>
          <summary>Original punches</summary>
          <dl class="gp-missed-recorded">
            <dt>Lunch Out</dt><dd>${esc(stamp(snapshot.lunch_out_at))}</dd>
            <dt>Lunch Back</dt><dd>${esc(stamp(snapshot.lunch_in_at))}</dd>
          </dl>
        </details>
        ${row.time_log_id ? `
          <p>Timecard #${esc(row.time_log_id)} · verify the punches and use Edit Punch if they need correction.</p>
          <form data-review-form="${row.id}">
            <label>Manager verification / correction note<input name="note" data-review-note required minlength="10" maxlength="1000"></label>
            <button type="submit">Mark clock-out reviewed</button>
            <div role="status" data-row-status></div>
          </form>` : `
          <button type="button" data-resolve-open>Resolve clock-out</button>
          <div data-row-status role="status"></div>
          <form data-review-form="${row.id}" hidden>
            <div data-existing-timecards hidden>
              <label>Matching timecard<select name="timecard"></select></label>
              <p>Verify these punches in Shift History. Select the matching timecard to link it to this review.</p>
            </div>
            <div data-new-timecard hidden>
              <p>No matching timecard was found. Enter the verified punches to save one.</p>
              <label>Actual clock-out<input name="endedAt" type="datetime-local"></label>
              <label>Unpaid lunch<select name="lunchMode">
                <option value="">Choose how to handle lunch</option>
                <option value="recorded">Enter actual Lunch Out and Lunch Back</option>
                <option value="none">Confirm no unpaid lunch</option>
              </select></label>
              <div data-actual-lunch hidden>
                <label>Actual Lunch Out<input name="lunchOut" type="datetime-local"></label>
                <label>Actual Lunch Back<input name="lunchBack" type="datetime-local"></label>
              </div>
              <p>Enter dates and times in ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}.</p>
            </div>
            <label>Manager verification / correction note<input name="note" data-review-note required minlength="10" maxlength="1000"></label>
            <button type="submit">Save and approve review</button>
            <button type="button" data-resolve-cancel>Cancel</button>
          </form>`}
      </article>`;
  }

  async function refresh(force = false) {
    if (!config?.getUser()?.perm_admin || busy) return;
    const out = get('gpAutoReviews');
    try {
      const result = await config.client.from('gp_shift_close_reviews').select('*').eq('status','pending')
        .order('due_at',{ascending:false}).limit(200);
      if (result.error) throw result.error;
      if (loadError) { get('gpAutoReviewMessage').textContent = ''; loadError = false; }
      const nextRows = result.data || [];
      const next = JSON.stringify(nextRows);
      if (!force && next === fingerprint) return;
      if (!force && (out.querySelector('[data-review-form][data-draft]') ||
          [...out.querySelectorAll('[data-review-note]')].some(el => el.value.trim()))) {
        get('gpAutoReviewMessage').textContent = 'The review queue changed. Finish your draft or refresh to load the latest records.';
        return;
      }
      rows = nextRows;
      fingerprint = next;
      out.innerHTML = rows.map(reviewCard).join('') || '<p>No automatic clock-outs awaiting review.</p>';
      get('gpAutoReviewCount').textContent = rows.length + (rows.length === 200 ? '+' : '') + ' pending';
    } catch (error) {
      loadError = true;
      (fingerprint ? get('gpAutoReviewMessage') : out).textContent =
        ['42P01','PGRST205'].includes(error.code) ? 'Install the automatic clock-out SQL to enable this review queue.'
          : 'Review queue could not load: ' + (error.message || error);
    }
  }

  function setLunchMode(form) {
    const usesLunch = form.elements.lunchMode.value === 'recorded';
    form.querySelector('[data-actual-lunch]').hidden = !usesLunch;
    form.elements.lunchOut.required = usesLunch;
    form.elements.lunchBack.required = usesLunch;
  }

  async function openResolution(button) {
    const card = button.closest('[data-review]');
    const row = rows.find(item => String(item.id) === card.dataset.review);
    if (!row || busy || button.disabled) return;
    const form = card.querySelector('form');
    const status = card.querySelector('[data-row-status]');
    const fields = form.elements;
    form.dataset.draft = '';
    button.disabled = true;
    status.textContent = 'Checking for matching timecards…';
    try {
      const {data,error} = await config.client.rpc('gp_missed_clock_out_candidates',{p_review_id:row.id});
      if (error) throw error;
      if (!form.isConnected) return;
      const candidates = data || [];
      fields.timecard.replaceChildren(new Option('Choose a matching timecard',''));
      for (const candidate of candidates) {
        const label = `${candidate.work_date} · ${candidate.clock_in}–${candidate.clock_out} · ${candidate.decimal_hours ?? '—'} hrs · ${candidate.break_minutes ?? 0} min lunch`;
        fields.timecard.add(new Option(label,candidate.id));
      }
      const useExisting = candidates.length > 0;
      form.querySelector('[data-existing-timecards]').hidden = !useExisting;
      form.querySelector('[data-new-timecard]').hidden = useExisting;
      fields.timecard.required = useExisting;
      fields.endedAt.required = fields.lunchMode.required = !useExisting;
      if (useExisting && candidates.length === 1) fields.timecard.value = String(candidates[0].id);
      const max = GP_CLOCK.localInput(Date.now());
      fields.endedAt.max = fields.lunchOut.max = fields.lunchBack.max = max;
      form.dataset.createsTimecard = String(!useExisting);
      const snapshot = row.session_snapshot;
      fields.lunchMode.value = !useExisting && (snapshot.lunch_out_at || snapshot.lunch_in_at) ? 'recorded' : '';
      fields.lunchOut.value = snapshot.lunch_out_at ? GP_CLOCK.localInput(Date.parse(snapshot.lunch_out_at)) : '';
      fields.lunchBack.value = snapshot.lunch_in_at ? GP_CLOCK.localInput(Date.parse(snapshot.lunch_in_at)) : '';
      setLunchMode(form);
      status.textContent = '';
      form.hidden = false;
      button.hidden = true;
      (useExisting ? fields.timecard : fields.endedAt).focus();
    } catch (error) {
      delete form.dataset.draft;
      status.textContent = error.code === 'PGRST202' ? 'The missed clock-out recovery SQL update is required.'
        : error.message || 'Could not load matching timecards.';
    } finally { button.disabled = false; }
  }

  async function saveReview(event) {
    const form = event.target.closest('[data-review-form]');
    if (!form) return;
    event.preventDefault();
    if (busy) return;
    const row = rows.find(item => String(item.id) === form.dataset.reviewForm);
    if (!row) return;
    const fields = form.elements;
    const status = form.closest('[data-review]').querySelector('[data-row-status]');
    const button = form.querySelector('button[type=submit]');
    const note = fields.note.value.trim();
    if (note.length < 10) { status.textContent = 'Enter a manager note of at least 10 characters.'; fields.note.focus(); return; }
    busy = button.disabled = true;
    status.textContent = 'Saving review…';
    let saved = false;
    try {
      const create = form.dataset.createsTimecard === 'true';
      const old = row.session_snapshot;
      const iso = (value,original) => original && value === GP_CLOCK.localInput(Date.parse(original))
        ? original : new Date(value).toISOString();
      const noLunch = create && fields.lunchMode.value === 'none';
      const {error} = create
        ? await config.client.rpc('gp_resolve_missed_clock_out',{
          p_review_id:row.id, p_ended_at:iso(fields.endedAt.value),
          p_lunch_out:noLunch ? null : iso(fields.lunchOut.value,old.lunch_out_at),
          p_lunch_back:noLunch ? null : iso(fields.lunchBack.value,old.lunch_in_at),
          p_no_lunch:noLunch, p_note:note
        })
        : await config.client.rpc('gp_review_auto_clock_out',{
          p_review_id:row.id, p_note:note, p_time_log_id:row.time_log_id || fields.timecard?.value || null
        });
      if (error) throw error;
      saved = true;
      get('gpAutoReviewMessage').textContent = create ? 'Corrected timecard saved and clock-out review approved.'
        : 'Clock-out review saved.';
      config.onSaved?.('Clock-out review saved.');
    } catch (error) { status.textContent = error.message || 'Review was not saved.'; }
    finally { busy = button.disabled = false; }
    if (saved) await refresh(true);
  }

  function mount(options) {
    if (config) return;
    config = options;
    const host = get('gpWidgetLiveTime');
    if (!host) return;
    const panel = document.createElement('section');
    panel.id = 'gpAutoReviewPanel';
    panel.innerHTML = `<div class="card-title"><span>Automatic clock-out reviews</span><span id="gpAutoReviewCount" class="badge badge-warn"></span></div>
      <p class="gp-week-hint">Regular missed punches default to 5 PM when checked at 12:01 AM Eastern. Starts after 6 PM remain open until 7:30 AM. Verify every automatic entry.</p>
      <button type="button" id="gpRefreshAutoReviews" class="btn-outline">Refresh reviews</button>
      <div id="gpAutoReviewMessage" role="status"></div><div id="gpAutoReviews"></div>`;
    host.appendChild(panel);
    get('gpRefreshAutoReviews').onclick = () => refresh(true);
    panel.addEventListener('submit',saveReview);
    panel.addEventListener('change',event => {
      if (event.target.name === 'lunchMode') setLunchMode(event.target.form);
    });
    panel.addEventListener('click',event => {
      const opener = event.target.closest('[data-resolve-open]');
      if (opener) void openResolution(opener);
      const cancel = event.target.closest('[data-resolve-cancel]');
      if (cancel && !busy) {
        const form = cancel.form;
        const card = form.closest('[data-review]');
        form.hidden = true;
        delete form.dataset.draft;
        card.querySelector('[data-row-status]').textContent = '';
        const open = card.querySelector('[data-resolve-open]');
        open.hidden = false;
        open.focus();
      }
    });
    void refresh();
    setInterval(() => { if (!document.hidden) void refresh(); },60000);
    document.addEventListener('visibilitychange',() => { if (!document.hidden) void refresh(); });
  }

  window.GP_AUTO_CLOCK_REVIEW = Object.freeze({mount,refresh});
})();
