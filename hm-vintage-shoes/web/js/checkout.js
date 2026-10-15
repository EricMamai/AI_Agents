import './layout.js';
import { api, cart, h, kes, loadCatalogue, loadConfig, normalizePhone, picture, resolveLines, sleep, swatch, toast } from './lib.js';

const WAIT_SECONDS = 120;
const ORDER_KEY = 'hm_last_order';

const $ = (selector) => document.querySelector(selector);
const checkout = $('[data-checkout]');
const empty = $('[data-empty]');
const form = $('[data-form]');
const summary = $('[data-summary]');
const payButton = $('[data-pay]');
const formError = $('[data-form-error]');
const banner = $('[data-mode-banner]');
const countySelect = $('#county');
const zoneNote = $('[data-zone-note]');
const otherNumber = $('[data-other-number]');
const mpesaField = $('[data-mpesa-field]');
const dialog = $('[data-dialog]');
const dialogBody = $('[data-dialog-body]');

let config;
let data;
try {
  [config, data] = await Promise.all([loadConfig(), loadCatalogue(true)]);
} catch {
  empty.querySelector('h2').textContent = 'We could not load checkout';
  empty.querySelector('p').textContent = 'Please check your connection and refresh the page.';
  empty.hidden = false;
  throw new Error('checkout unavailable');
}

/* A payment that finished after the dialog was closed: confirm it and move on. */
const lastToken = sessionStorage.getItem(ORDER_KEY);
if (lastToken) {
  try {
    const last = await api(`/api/orders/${encodeURIComponent(lastToken)}`);
    if (last.status === 'paid') {
      cart.clear();
      location.replace(`/order?t=${encodeURIComponent(lastToken)}`);
      await new Promise(() => {});
    }
  } catch { /* unknown order: ignore */ }
}

/* ---------------------------------------------------------------- set-up */

if (config.mode !== 'production') {
  banner.textContent = config.mode === 'simulate'
    ? 'Demo mode: M-Pesa payments are simulated. No real prompt is sent and no money moves.'
    : 'Sandbox mode: payments run against Safaricom\u2019s test environment, not real money.';
  banner.hidden = false;
}

const zoneById = Object.fromEntries(config.zones.map((z) => [z.id, z]));
const zoneByCounty = new Map(config.counties.map((c) => [c.name, zoneById[c.zone]]));
countySelect.append(...config.counties.map((c) => h('option', { value: c.name }, c.name)));

const currentZone = () => zoneByCounty.get(countySelect.value) ?? null;

function renderSummary() {
  const rows = resolveLines(cart.lines(), data);
  if (!rows.length) {
    checkout.hidden = true;
    empty.hidden = false;
    return null;
  }
  empty.hidden = true;
  checkout.hidden = false;

  const payable = rows.filter((r) => r.ok);
  const subtotal = payable.reduce((sum, r) => sum + r.product.price * r.qty, 0);
  const zone = currentZone();
  const total = subtotal + (zone ? zone.fee : 0);
  const blocked = payable.length !== rows.length;

  const line = (r) => h('li', { class: r.ok ? 'summary-line' : 'summary-line is-unavailable' },
    r.product ? h('div', { class: 'summary-img' }, picture(r.product.images[0], { sizes: '72px' }), h('span', { class: 'summary-qty' }, String(r.qty))) : null,
    h('div', {},
      h('p', { class: 'summary-name' }, r.product ? r.product.name : 'Item no longer available'),
      r.product ? h('p', { class: 'summary-meta' }, swatch(r.colour), `${r.colour.name} \u00b7 EU ${r.size}`) : null,
      r.ok ? null : h('p', { class: 'summary-meta warn' }, r.available ? `Only ${r.available} left in this size` : 'Sold out in this size')),
    r.product ? h('strong', {}, kes(r.product.price * r.qty)) : null);

  summary.replaceChildren(...[
    h('h2', {}, 'Order summary'),
    h('ul', { class: 'summary-lines' }, ...rows.map(line)),
    h('dl', { class: 'summary-totals' },
      h('div', {}, h('dt', {}, 'Subtotal'), h('dd', {}, kes(subtotal))),
      h('div', {}, h('dt', {}, 'Delivery'), h('dd', {}, zone ? kes(zone.fee) : 'Choose county')),
      h('div', { class: 'total' }, h('dt', {}, 'Total'), h('dd', {}, kes(total)))),
    blocked ? h('p', { class: 'form-error' }, 'Some items are no longer available. Open your bag to remove them.') : null,
    h('button', { class: 'link-btn', type: 'button', onclick: () => document.dispatchEvent(new Event('hm:open-cart')) }, 'Edit bag'),
  ].filter(Boolean));

  payButton.textContent = zone ? `Pay ${kes(total)} with M-Pesa` : 'Pay with M-Pesa';
  payButton.disabled = blocked || dialog.open;
  zoneNote.textContent = zone ? `${zone.label}: ${kes(zone.fee)}, arriving ${zone.eta.toLowerCase()}.` : 'Delivery fee and time depend on your county.';
  return { rows, payable, subtotal, total };
}

countySelect.addEventListener('change', renderSummary);
cart.subscribe(renderSummary);
otherNumber.addEventListener('change', () => { mpesaField.hidden = !otherNumber.checked; if (otherNumber.checked) form.elements.mpesaPhone.focus(); });
renderSummary();

/* ------------------------------------------------------------ validation */

const rules = {
  name: (v) => (v.trim().length >= 2 ? '' : 'Enter your full name.'),
  phone: (v) => (normalizePhone(v) ? '' : 'Enter a valid Kenyan number, for example 0712 345 678.'),
  county: (v) => (v ? '' : 'Choose your county.'),
  town: (v) => (v.trim().length >= 2 ? '' : 'Enter your town or area.'),
  address: (v) => (v.trim().length >= 5 ? '' : 'Add a street, building or landmark so the courier can find you.'),
  mpesaPhone: (v) => (!otherNumber.checked || normalizePhone(v) ? '' : 'Enter a valid M-Pesa number, for example 0712 345 678.'),
};

function check(name) {
  const input = form.elements[name];
  const output = form.querySelector(`[data-error-for="${name}"]`);
  const message = rules[name](input.value);
  output.textContent = message;
  output.id ||= `error-${name}`;
  input.setAttribute('aria-invalid', String(Boolean(message)));
  if (message) input.setAttribute('aria-describedby', output.id); else input.removeAttribute('aria-describedby');
  return message === '';
}

for (const name of Object.keys(rules)) {
  form.elements[name].addEventListener('blur', () => { if (form.elements[name].value) check(name); });
  form.elements[name].addEventListener('input', () => { if (form.elements[name].getAttribute('aria-invalid') === 'true') check(name); });
}

/* --------------------------------------------------------------- payment */

let session = 0;
let sending = false;
let countdown = null;

function showDialog(...nodes) {
  dialogBody.replaceChildren(...nodes);
  if (!dialog.open) dialog.showModal();
  dialogBody.querySelector('h2')?.focus();
}

const heading = (text) => h('h2', { id: 'pay-title', tabindex: '-1' }, text);

function sendingView() {
  return [h('div', { class: 'pay-state' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    heading('Sending your M-Pesa request'),
    h('p', {}, 'Please keep this page open.'))];
}

function waitingView(order) {
  const remaining = h('strong', {}, '2:00');
  const fill = h('span', { class: 'bar-fill' });
  countdown = (elapsed) => {
    const left = Math.max(0, WAIT_SECONDS - elapsed);
    remaining.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    fill.style.setProperty('--p', String(Math.min(1, elapsed / WAIT_SECONDS)));
  };
  return [h('div', { class: 'pay-state' },
    h('span', { class: 'mpesa-badge' }, 'M-PESA'),
    heading('Check your phone'),
    h('p', {}, `We sent a request for ${kes(order.total)} to ${order.mpesaPhone}.`),
    h('ol', { class: 'pay-steps' },
      h('li', {}, 'Look for the M-Pesa prompt on your phone.'),
      h('li', {}, 'Enter your M-Pesa PIN to approve the payment.'),
      h('li', {}, 'Stay on this page. We confirm automatically.')),
    h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Time left to approve the payment' }, fill),
    h('p', { class: 'fine' }, 'Time left: ', remaining),
    order.mode === 'simulate' ? simulator(order) : null,
    h('button', { class: 'link-btn', type: 'button', onclick: () => dialog.close() }, 'Close'))];
}

function simulator(order) {
  const outcomes = [['success', 'Approve with PIN'], ['cancelled', 'Cancel request'], ['insufficient', 'Insufficient funds'], ['wrong_pin', 'Wrong PIN'], ['timeout', 'Prompt timed out']];
  return h('div', { class: 'sim' },
    h('p', {}, h('strong', {}, 'Simulation mode. '), 'No real M-Pesa request was sent. Choose what happens on the phone:'),
    h('div', { class: 'sim-buttons' }, ...outcomes.map(([outcome, label]) => h('button', {
      class: outcome === 'success' ? 'btn btn-mpesa btn-sm' : 'btn btn-ghost btn-sm',
      type: 'button',
      onclick: async () => {
        try { settle(await api(`/api/orders/${encodeURIComponent(order.token)}/simulate`, { method: 'POST', body: { outcome } })); } catch (error) { toast(error.message); }
      },
    }, label))));
}

function failureView(message) {
  return [h('div', { class: 'pay-state is-failed' },
    h('span', { class: 'cross', 'aria-hidden': 'true' }),
    heading('Payment not completed'),
    h('p', {}, message),
    h('p', { class: 'fine' }, 'No money is taken unless you enter your M-Pesa PIN.'),
    h('div', { class: 'pay-actions' }, h('button', { class: 'btn btn-mpesa', type: 'button', onclick: () => dialog.close() }, 'Try again')))];
}

function slowView(order) {
  return [h('div', { class: 'pay-state' },
    heading('We are still waiting for M-Pesa'),
    h('p', {}, 'We have not received confirmation yet. If you approved the payment, please wait a moment. If M-Pesa has already charged you, do not pay again.'),
    h('div', { class: 'pay-actions' },
      h('button', { class: 'btn btn-mpesa', type: 'button', onclick: () => watch(order) }, 'Check again'),
      h('a', { class: 'btn btn-ghost', href: `/order?t=${encodeURIComponent(order.token)}` }, 'View order status'),
      h('button', { class: 'link-btn', type: 'button', onclick: () => dialog.close() }, 'Close')))];
}

function successView(order) {
  return [h('div', { class: 'pay-state is-success' },
    h('span', { class: 'tick', 'aria-hidden': 'true' }),
    heading('Payment received'),
    h('p', {}, order.receipt ? `M-Pesa receipt ${order.receipt}` : 'Thank you for your order.'),
    h('p', { class: 'fine' }, 'Taking you to your order\u2026'))];
}

/** Returns true when the order reached a final state. */
function settle(order) {
  if (order.status === 'paid') {
    session += 1;
    showDialog(...successView(order));
    setTimeout(() => { location.href = `/order?t=${encodeURIComponent(order.token)}`; }, 1500);
    return true;
  }
  if (['failed', 'expired', 'cancelled'].includes(order.status)) {
    session += 1;
    showDialog(...failureView(order.message || 'M-Pesa could not complete the payment.'));
    return true;
  }
  return false;
}

async function watch(order) {
  const mine = ++session;
  const started = Date.now();
  showDialog(...waitingView(order));
  const timer = setInterval(() => countdown?.((Date.now() - started) / 1000 | 0), 1000);
  try {
    while (mine === session) {
      await sleep(3000);
      if (mine !== session) return;
      let latest;
      try { latest = await api(`/api/orders/${encodeURIComponent(order.token)}`); } catch { continue; }
      if (mine !== session || settle(latest)) return;
      if ((Date.now() - started) / 1000 > WAIT_SECONDS) {
        session += 1;
        showDialog(...slowView(order));
        return;
      }
    }
  } finally {
    clearInterval(timer);
  }
}

dialog.addEventListener('cancel', (event) => { if (sending) event.preventDefault(); });
dialog.addEventListener('close', () => {
  session += 1;
  payButton.disabled = false;
  renderSummary();
  payButton.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.hidden = true;

  const names = Object.keys(rules);
  const invalid = names.filter((name) => !check(name));
  if (invalid.length) {
    form.elements[invalid[0]].focus();
    return;
  }
  const state = renderSummary();
  if (!state || state.payable.length !== state.rows.length) {
    formError.textContent = 'Please review your bag before paying.';
    formError.hidden = false;
    return;
  }

  const value = (name) => form.elements[name].value.trim();
  payButton.disabled = true;
  sending = true;
  showDialog(...sendingView());
  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: {
        items: state.payable.map((r) => ({ id: r.id, size: r.size, qty: r.qty })),
        customer: { name: value('name'), phone: value('phone') },
        delivery: { county: value('county'), town: value('town'), address: value('address'), notes: value('notes') },
        mpesaPhone: otherNumber.checked ? value('mpesaPhone') : undefined,
      },
    });
    sessionStorage.setItem(ORDER_KEY, order.token);
    sending = false;
    await watch(order);
  } catch (error) {
    sending = false;
    session += 1;
    showDialog(...failureView(error.message));
    if (error.status === 409) {
      try { data = await loadCatalogue(true); renderSummary(); } catch { /* keep old data */ }
    }
  }
});
