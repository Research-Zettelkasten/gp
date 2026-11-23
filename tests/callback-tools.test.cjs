const test = require('node:test');
const assert = require('node:assert/strict');
const callbacks = require('../gp-callback-tools');
const fleet = require('../gp-fleet-records');
const today = '2026-11-23';
const quote = (quote_number, fields) => ({quote_number, quote_date:'11/12/2026', status:'open', phone:'(229) 555-0100', ...fields});

test('callback sorting combines priority, due date, status and text search without changing records', () => {
  const rows = [
    quote(1,{customer_name:'Sample Café',parts:[{part:'DW-100'}]}),
    quote(2,{status:'follow_up',call_data:{expected_answer_date:'11/21/2026'}}),
    quote(3,{status:'follow_up',call_data:{expected_answer_date:today}}),
    quote(4,{status:'admin_review',call_data:{manager_close_required:true}}),
    quote(5,{status:'follow_up',call_data:{expected_answer_date:'11/25/2026'}})
  ];
  assert.deepEqual(callbacks.select(rows,{status:'ACTIVE'},today).map(r=>r.quote.quote_number),[2,3,1,5]);
  assert.deepEqual(callbacks.select(rows,{status:'MANAGER'},today).map(r=>r.quote.quote_number),[4]);
  assert.deepEqual(callbacks.select(rows,{search:'cafe DW 100',from:'2026-11-11',to:'2026-11-13'},today).map(r=>r.quote.quote_number),[1]);
  assert.equal(callbacks.select(rows,{due:'upcoming'},today)[0].quote.quote_number,5);
  assert.equal(callbacks.dateOnly('02/30/2026'),'');
});

test('contact links validate targets and encode draft content', () => {
  const phone = '+1 (229) 555-0100';
  assert.deepEqual(callbacks.links(phone,'','','hello',false),{call:'tel:+12295550100',text:'',email:''});
  assert.equal(callbacks.links(phone,'sample+quote@example.test','Quote #17','A & B',true).email,
    'mailto:sample%2Bquote@example.test?subject=Quote%20%2317&body=A%20%26%20B');
  assert.equal(callbacks.links(phone,'abc@example.test?bcc=other@example.test','','',true).email,'');
});

test('fleet renewal priority distinguishes missing, late and due dates', () => {
  assert.equal(fleet.tagStatus(null,today),'missing');
  assert.equal(fleet.tagStatus('2026-11-22',today),'expired');
  assert.equal(fleet.tagStatus('2026-12-23',today),'soon');
  assert.equal(fleet.tagStatus('2026-12-24',today),'upcoming');
  assert.equal(fleet.tagStatus('2027-01-23',today),'current');
});
