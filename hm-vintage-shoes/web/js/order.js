import './layout.js';
import { api, cart, h, kes, loadConfig, picture, sleep } from './lib.js';

const root = document.querySelector('[data-order]');
const token = new URLSearchParams(location.search).get('t');

function notFound() {
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('div', { class: 'empty-state wide' },
    h('h1', {}, 'We could not find that order'),
    h('p', {}, 'The link may be incomplete. Orders are found with the link shown right after payment.'),
    h('a', { class: 'btn btn-primary', href: '/shop' }, 'Continue shopping')));
}

function itemsPanel(order) {
  return h('section', { class: 'panel' },
    h('h2', {}, 'Your shoes'),
    h('ul', { class: 'summary-lines' }, ...order.items.map((item) => h('li', { class: 'summary-line' },
      h('div', { class: 'summary-img' }, picture({ photo: item.image, alt: item.name }, { sizes: '72px' }), h('span', { class: 'summary-qty' }, String(item.qty))),
      h('div', {}, h('p', { class: 'summary-name' }, item.name), h('p', { class: 'summary-meta' }, `EU ${item.size}`)),
      h('strong', {}, kes(item.price * item.qty))))),
    h('dl', { class: 'summary-totals' },
      h('div', {}, h('dt', {}, 'Subtotal'), h('dd', {}, kes(order.subtotal))),
      h('div', {}, h('dt', {}, 'Delivery'), h('dd', {}, kes(order.deliveryFee))),
      h('div', { class: 'total' }, h('dt', {}, 'Total paid'), h('dd', {}, kes(order.total)))));
}

function paidView(order, zone) {
  const first = order.customerName.split(' ')[0];
  return [
    h('section', { class: 'order-hero is-success' },
      h('span', { class: 'tick', 'aria-hidden': 'true' }),
      h('p', { class: 'eyebrow' }, `Order ${order.number}`),
      h('h1', {}, `Asante, ${first}. Your payment is confirmed.`),
      h('p', { class: 'lead-sm' }, order.receipt ? h('span', {}, 'M-Pesa receipt ', h('strong', {}, order.receipt), ` \u00b7 ${kes(order.total)}`) : `${kes(order.total)} received.`),
      order.simulated ? h('p', { class: 'mode-banner' }, 'This was a simulated payment. No money moved.') : null),
    h('div', { class: 'order-grid' },
      itemsPanel(order),
      h('section', { class: 'panel' },
        h('h2', {}, 'Delivery'),
        h('p', {}, order.customerName, h('br'), order.address, h('br'), `${order.town}, ${order.county}`),
        h('h2', { class: 'spaced' }, 'What happens next'),
        h('ol', { class: 'timeline' },
          h('li', { class: 'done' }, h('strong', {}, 'Payment confirmed'), h('span', {}, `Paid from ${order.mpesaPhone}`)),
          h('li', {}, h('strong', {}, 'We prepare your pair'), h('span', {}, 'Cleaned, checked and packed')),
          h('li', {}, h('strong', {}, `Delivered to ${order.county}`), h('span', {}, zone ? `Estimated: ${zone.eta}` : 'We will call you before delivery'))))),
    h('p', { class: 'center' }, h('a', { class: 'btn btn-primary', href: '/shop' }, 'Continue shopping')),
  ];
}

function pendingView(order) {
  return [h('section', { class: 'order-hero' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('p', { class: 'eyebrow' }, `Order ${order.number}`),
    h('h1', {}, 'Waiting for your M-Pesa payment'),
    h('p', { class: 'lead-sm' }, `Approve the request for ${kes(order.total)} on ${order.mpesaPhone} with your M-Pesa PIN. This page updates by itself.`),
    h('a', { class: 'link-btn', href: '/checkout' }, 'Back to checkout'))];
}

function failedView(order) {
  return [h('section', { class: 'order-hero is-failed' },
    h('span', { class: 'cross', 'aria-hidden': 'true' }),
    h('p', { class: 'eyebrow' }, `Order ${order.number}`),
    h('h1', {}, 'Payment not completed'),
    h('p', { class: 'lead-sm' }, order.message || 'M-Pesa could not complete the payment.'),
    h('p', { class: 'fine' }, 'No money is taken unless you enter your M-Pesa PIN. Your bag is still saved.'),
    h('p', {}, h('a', { class: 'btn btn-mpesa', href: '/checkout' }, 'Try paying again')))];
}

async function main() {
  if (!token) return notFound();
  let order;
  try {
    order = await api(`/api/orders/${encodeURIComponent(token)}`);
  } catch (error) {
    if (error.status === 404) return notFound();
    root.replaceChildren(h('p', { class: 'muted' }, 'We could not load your order. Please refresh the page.'));
    return;
  }
  const config = await loadConfig().catch(() => null);

  for (;;) {
    root.removeAttribute('aria-busy');
    if (order.status === 'paid') {
      cart.clear();
      sessionStorage.removeItem('hm_last_order');
      const zoneId = config?.counties.find((c) => c.name === order.county)?.zone;
      document.title = `Order ${order.number} confirmed | HM`;
      root.replaceChildren(...paidView(order, config?.zones.find((z) => z.id === zoneId)));
      return;
    }
    root.replaceChildren(...(order.status === 'pending' ? pendingView(order) : failedView(order)));
    if (order.status !== 'pending') return;
    await sleep(3000);
    try { order = await api(`/api/orders/${encodeURIComponent(token)}`); } catch { /* keep polling */ }
  }
}

main();
