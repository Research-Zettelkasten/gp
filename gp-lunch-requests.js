(() => {
  'use strict';
  const east = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', dateStyle:'medium', timeStyle:'short'});
  const showTime = value => value ? east.format(new Date(value)) : '—';
  const missing = error => ['PGRST202','PGRST205','42P01'].includes(error?.code);
  const unavailable = 'Lunch correction requests are awaiting the Supabase update.';
  const savedFields = 'id,employee_name,shift_start,previous_lunch,requested_out,requested_back,reason,status,review_note';
  const recorded = (wall, exact) => wall ? wall + ' ET' : showTime(exact);
  const recordedPair = ({out,back,wall_out,wall_back,minutes}) =>
    out || back || wall_out || wall_back ? recorded(wall_out,out) + ' → ' + recorded(wall_back,back)
      : minutes > 0 ? minutes + ' min (no exact punches)' : 'No lunch recorded';

  function requestItem(request) {
    const entry = document.createElement('article');
    entry.className = 'gp-correction-request';
    const title = document.createElement('strong');
    title.textContent = request.employee_name + ' · ' + showTime(request.shift_start) + ' ET';
    const times = document.createElement('div');
    times.className = 'gp-correction-times';
    for (const [label,value] of [
      ['Recorded lunch', recordedPair(request.previous_lunch)],
      ['Requested lunch · Eastern', showTime(request.requested_out) + ' → ' + showTime(request.requested_back)]
    ]) {
      const block = document.createElement('div');
      const caption = document.createElement('small');
      caption.textContent = label;
      block.append(caption, value);
      times.append(block);
    }
    const reason = document.createElement('p');
    reason.textContent = request.reason;
    entry.append(title,times,reason);
    return entry;
  }

  function mountEmployee({client, getUser, getShifts}) {
    const host = document.getElementById('timeLunchRequestPane');
    const form = host.querySelector('form');
    const shift = form.elements.shift;
    const out = form.elements.lunchOut;
    const back = form.elements.lunchBack;
    const reason = form.elements.reason;
    const send = form.querySelector('button');
    const status = host.querySelector('[data-lunch-request-status]');
    const history = host.querySelector('[data-lunch-request-history]');
    const shiftInfo = host.querySelector('[data-lunch-request-shift]');
    let available = new Map();
    let loading = false;
    let busy = false;
    let revision = 0;

    function fillTimes() {
      const row = available.get(shift.value);
      const inputValue = (exact, wall) => {
        if (!exact) return '';
        const display = GP_TIME.parts(Date.parse(exact));
        return !wall || wall === display.hour + ':' + display.minute ? GP_CLOCK.localInput(Date.parse(exact)) : '';
      };
      out.value = inputValue(row?.lunch_out_at, row?.lunch_out_time);
      back.value = inputValue(row?.lunch_in_at, row?.lunch_in_time);
      shiftInfo.textContent = !row ? '' : 'Recorded lunch: ' + recordedPair({
        out:row.lunch_out_at,back:row.lunch_in_at,wall_out:row.lunch_out_time,wall_back:row.lunch_in_time,minutes:row.break_minutes
      });
    }

    function refreshChoices() {
      const me = getUser();
      if (!me) return;
      const selected = shift.value;
      const {live, cards} = getShifts();
      available = new Map();
      if (live?.started_at_ms) available.set('live:' + live.started_at_ms, live);
      const saved = cards.filter(row => row.auth_user_id === me.auth_user_id && row.id != null)
        .sort((a,b) => b.work_date.localeCompare(a.work_date) || Number(b.id) - Number(a.id));
      for (const row of saved) available.set('card:' + row.id, row);
      shift.replaceChildren();
      for (const [key,row] of available) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = key.startsWith('live:') ? 'Current shift · ' + showTime(GP_TIME.effectiveStart(row)) + ' ET'
          : [row.work_date, row.clock_in + '–' + row.clock_out + ' ET'].join(' · ');
        shift.append(option);
      }
      if (available.has(selected)) shift.value = selected;
      else fillTimes();
      send.disabled = !available.size || busy;
      form.hidden = !available.size;
      host.querySelector('[data-lunch-request-empty]').hidden = Boolean(available.size);
    }

    async function loadHistory() {
      const me = getUser();
      if (!me || loading) return;
      const current = ++revision;
      loading = true;
      try {
        const {data,error} = await client.from('gp_lunch_requests').select(savedFields).eq('employee_id',me.auth_user_id)
          .order('created_at',{ascending:false}).limit(30);
        if (getUser()?.auth_user_id !== me.auth_user_id || current !== revision) return;
        if (error) throw error;
        const entries = (data || []).map(r => {
          const item = requestItem(r);
          const line = document.createElement('p');
          const label = {pending:'Pending manager review',approved:'Approved',rejected:'Rejected'}[r.status];
          line.textContent = r.review_note ? label + ' · ' + r.review_note : label;
          item.append(line);
          return item;
        });
        history.replaceChildren(...entries.length ? entries : [document.createTextNode('No lunch correction requests yet.')]);
      } catch (error) {
        if (getUser()?.auth_user_id === me.auth_user_id && current === revision)
          history.textContent = missing(error) ? unavailable : 'Could not load your requests. Reopen this tab to retry.';
      } finally { loading = false; }
    }

    shift.addEventListener('change', fillTimes);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !getUser() || !available.has(shift.value)) return;
      const who = getUser().auth_user_id;
      const [type,id] = shift.value.split(':');
      const row = available.get(shift.value);
      const requested = (value, previous) => previous && value === GP_CLOCK.localInput(Date.parse(previous))
        ? previous : new Date(value).toISOString();
      busy = send.disabled = true;
      status.textContent = 'Sending your request…';
      try {
        const {error} = await client.rpc('gp_request_lunch_change', {
          p_session_start_ms:type === 'live' ? id : null, p_time_log_id:type === 'card' ? id : null,
          p_lunch_out:requested(out.value,row.lunch_out_at), p_lunch_back:requested(back.value,row.lunch_in_at),
          p_reason:reason.value.trim()
        });
        if (getUser()?.auth_user_id !== who) return;
        if (error) throw error;
        reason.value = '';
        fillTimes();
        status.textContent = 'Request sent. Your punches will update after manager approval.';
        void loadHistory();
      } catch (error) {
        if (getUser()?.auth_user_id === who)
          status.textContent = missing(error) ? unavailable : error.message || 'Could not send your request.';
      } finally { busy = false; send.disabled = !available.size; }
    });

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    host.querySelector('[data-lunch-request-timezone]').textContent = 'Enter dates and times in ' + timezone.replaceAll('_',' ') + '.';
    return {
      open() { refreshChoices(); void loadHistory(); },
      reset() { revision++; available.clear(); form.reset(); shift.replaceChildren(); history.replaceChildren(); status.textContent = ''; shiftInfo.textContent = ''; }
    };
  }

  function mountAdmin({client,onReviewed}) {
    const host = document.getElementById('gpLunchRequestReview');
    const status = host.querySelector('[data-lunch-review-status]');
    const list = host.querySelector('[data-lunch-review-list]');
    const refresh = host.querySelector('[data-lunch-review-refresh]');
    let busy = false;

    async function load() {
      if (busy) return;
      busy = refresh.disabled = true;
      try {
        const {data,error} = await client.from('gp_lunch_requests').select(savedFields)
          .eq('status','pending').order('created_at',{ascending:true}).limit(100);
        if (error) throw error;
        list.replaceChildren();
        if (!data?.length) list.textContent = 'No lunch corrections awaiting review.';
        for (const request of data || []) {
          const item = requestItem(request);
          const form = document.createElement('form');
          form.innerHTML = `
            <label for="gpLunchReviewNote-${Number(request.id)}">Manager review note</label>
            <textarea id="gpLunchReviewNote-${Number(request.id)}" name="note" required minlength="10" maxlength="1000" rows="2"></textarea>
            <div class="gp-correction-actions">
              <button type="submit" name="decision" value="approve" class="gp-correction-approve">Approve</button>
              <button type="submit" name="decision" value="reject">Reject</button>
            </div>`;
          form.onsubmit = async event => {
            event.preventDefault();
            if (busy) return;
            const approve = event.submitter?.value === 'approve';
            busy = refresh.disabled = true;
            const controls = [...form.querySelectorAll('button')];
            controls.forEach(button => { button.disabled = true; });
            status.textContent = 'Saving the review…';
            let saved = false;
            try {
              const result = await client.rpc('gp_review_lunch_change',
                {p_request_id:String(request.id),p_approve:approve,p_note:form.elements.note.value.trim()});
              if (result.error) throw result.error;
              saved = true;
              status.textContent = approve ? 'Approved. The lunch punches and paid hours were updated.' : 'Request rejected.';
              onReviewed();
            } catch (error) { status.textContent = error.message || 'Could not save the review.'; }
            finally {
              busy = refresh.disabled = false;
              controls.forEach(button => { button.disabled = false; });
            }
            if (saved) void load();
          };
          item.append(form);
          list.append(item);
        }
      } catch (error) {
        status.textContent = missing(error) ? unavailable : 'Could not load requests. Try Refresh.';
      } finally { busy = refresh.disabled = false; }
    }

    refresh.onclick = () => { status.textContent = ''; void load(); };
    void load();
    return {load};
  }

  window.GP_LUNCH_REQUESTS = Object.freeze({mountEmployee,mountAdmin});
})();
