(function (root) {
  'use strict';
  const scripts = {
    voicemail: 'Hi, this is {csr} from GLASSPRO. I’m following up on quote #{quote}. Please call us at (229) 244-8484 when you have a moment.',
    scheduling: 'If the quote works for you, let’s check which installation or service times are available. Which days work best?',
    pricing: 'What part of the quote would you like to review? I can explain the scope, then check with a manager about any pricing changes.',
    manager: 'I’d like a manager to review the details so we can give you a firm answer. When is a good time for them to call you back?'
  };
  function dateOnly(value) {
    const text = String(value || '').trim();
    const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    const iso = local ? local[3] + '-' + local[1].padStart(2,'0') + '-' + local[2].padStart(2,'0') : text;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    const stamp = Date.parse(iso);
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === iso ? iso : '';
  }
  function phone(value) {
    const text = String(value || '').trim();
    if (!/^\+?[\d(). -]+$/.test(text)) return '';
    const digits = text.replace(/\D/g,'');
    return digits.length >= 7 && digits.length <= 15 ? (text.startsWith('+') ? '+' : '') + digits : '';
  }
  function email(value) {
    const text = String(value || '').trim();
    return text.length <= 254 && /^[a-z0-9.!#$%&'*+=_/^~`{|}-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(text) ? text : '';
  }
  function links(value, address, subject, body, hasCell) {
    const number = phone(value), recipient = email(address);
    const content = encodeURIComponent(body);
    return {
      call: number ? 'tel:' + number : '',
      text: number && hasCell ? 'sms:' + number + '?body=' + content : '',
      email: recipient ? 'mailto:' + encodeURIComponent(recipient).replace('%40','@') + '?subject=' + encodeURIComponent(subject) + '&body=' + content : ''
    };
  }
  function priority(quote, today) {
    const due = dateOnly(quote.call_data?.expected_answer_date);
    if (quote.status === 'admin_review' && quote.call_data?.manager_close_required) return {rank:0, due:'', reason:'Manager close requested'};
    if (quote.status === 'follow_up' && due && due < today) return {rank:1, due, reason:'Overdue follow-up'};
    if (quote.status === 'follow_up' && due === today) return {rank:2, due, reason:'Follow-up due today'};
    if (!['open','follow_up'].includes(quote.status)) return {rank:7, due:'', reason:''};
    if (!phone(quote.phone)) return {rank:6, due, reason:'Verify contact details'};
    if (quote.status === 'follow_up' && due) return {rank:5, due, reason:'Upcoming follow-up'};
    if (quote.status === 'follow_up') return {rank:3, due:'', reason:'Follow-up needs a date'};
    if (!Number(quote.contact_attempts)) return {rank:3, due:'', reason:'First contact'};
    return {rank:4, due:'', reason:'Retry contact'};
  }
  function searchWords(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().match(/[a-z0-9]+/g) || [];
  }
  function select(quotes, filters, today) {
    const words = searchWords(filters.search);
    const phoneSearch = /^[\d(). +\-]{7,}$/.test(filters.search || '') ? filters.search.replace(/\D/g,'') : '';
    const rows = [];
    for (const quote of quotes) {
      const date = dateOnly(quote.quote_date), p = priority(quote, today);
      const call = phone(quote.phone), attempts = Number(quote.contact_attempts) || 0;
      if (filters.module && filters.module !== 'ALL' && quote.module !== filters.module) continue;
      if (filters.csr && filters.csr !== 'ALL' && quote.csr !== filters.csr) continue;
      if (filters.status === 'ACTIVE' && !['open','follow_up'].includes(quote.status)) continue;
      if (filters.status === 'OPEN_ONLY' && quote.status !== 'open') continue;
      if (filters.status === 'FOLLOW_UP' && quote.status !== 'follow_up') continue;
      if (filters.status === 'MANAGER' && p.rank !== 0) continue;
      if (filters.due === 'overdue' && (quote.status !== 'follow_up' || !p.due || p.due >= today)) continue;
      if (filters.due === 'today' && (quote.status !== 'follow_up' || p.due !== today)) continue;
      if (filters.due === 'upcoming' && (quote.status !== 'follow_up' || p.due <= today)) continue;
      if (filters.due === 'first' && (quote.status !== 'open' || attempts)) continue;
      if (filters.contact === 'phone' && !call || filters.contact === 'text' && !(call && quote.has_cell) ||
          filters.contact === 'missing' && call) continue;
      if (filters.from && (!date || date < filters.from) || filters.to && (!date || date > filters.to)) continue;
      if (filters.min !== '' && filters.min != null && Number(quote.total) < Number(filters.min)) continue;
      if (words.length) {
        const hay = searchWords([
          quote.quote_number, quote.customer_name, quote.phone, quote.module, quote.csr,
          ...(quote.parts || []).flatMap(part => [part.part,part.desc,part.category])
        ].join(' ')).join(' ');
        if (!(phoneSearch && call.replace(/\D/g,'').includes(phoneSearch)) && !words.every(word => hay.includes(word))) continue;
      }
      rows.push({quote,date,...p});
    }
    const byDate = (a,b) => (b.date || '').localeCompare(a.date || '');
    const byValue = (a,b) => (Number(b.quote.total) || 0) - (Number(a.quote.total) || 0);
    return rows.sort((a,b) => {
      const chosen = filters.sort === 'newest' ? byDate(a,b)
        : filters.sort === 'oldest' ? (a.date || '9999').localeCompare(b.date || '9999')
        : filters.sort === 'value' ? byValue(a,b)
        : a.rank - b.rank || (a.due || '9999').localeCompare(b.due || '9999') ||
          (a.rank === 3 || a.rank === 4 ? (a.date || '9999').localeCompare(b.date || '9999') : 0) || byValue(a,b);
      return chosen || byDate(a,b) || Number(b.quote.quote_number) - Number(a.quote.quote_number);
    });
  }
  const api = {scripts, dateOnly, phone, email, links, priority, select};
  if (typeof module === 'object') module.exports = api;
  else root.GP_CALLBACKS = api;
})(globalThis);
