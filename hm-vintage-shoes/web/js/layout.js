import { cart, h, kes, loadCatalogue, picture, resolveLines, swatch, MAX_QTY } from './lib.js';

const drawer = document.getElementById('cart-drawer');
const overlay = document.querySelector('.overlay');
const nav = document.getElementById('site-nav');
const menuButton = document.querySelector('.menu-btn');
let returnFocus = null;

/* ------------------------------------------------------------ header + nav */

menuButton.addEventListener('click', () => {
  const open = nav.classList.toggle('is-open');
  menuButton.setAttribute('aria-expanded', String(open));
});

nav.addEventListener('click', (event) => {
  if (!event.target.closest('a')) return;
  nav.classList.remove('is-open');
  menuButton.setAttribute('aria-expanded', 'false');
});

if (/^\/(shop|product)/.test(location.pathname)) {
  document.querySelector('[data-nav="shop"]')?.setAttribute('aria-current', 'page');
}

function updateBadge() {
  const count = cart.count();
  document.querySelectorAll('[data-cart-count]').forEach((el) => {
    el.textContent = count;
    el.classList.toggle('has-items', count > 0);
  });
}

/* ------------------------------------------------------------------ drawer */

/** Keeps keyboard and screen-reader focus inside the open drawer. */
function setPageInert(inert) {
  for (const el of document.body.children) {
    if (el === drawer || el === overlay || el.tagName === 'SCRIPT' || el.hasAttribute('data-toast')) continue;
    el.inert = inert;
  }
}

function openCart() {
  returnFocus = document.activeElement;
  setPageInert(true);
  drawer.inert = false;
  drawer.classList.add('is-open');
  overlay.classList.add('is-open');
  document.body.classList.add('no-scroll');
  render();
  drawer.querySelector('.icon-btn').focus();
}

function closeCart() {
  drawer.classList.remove('is-open');
  overlay.classList.remove('is-open');
  document.body.classList.remove('no-scroll');
  drawer.inert = true;
  setPageInert(false);
  if (returnFocus instanceof HTMLElement) returnFocus.focus();
}

document.querySelectorAll('[data-open-cart]').forEach((el) => el.addEventListener('click', openCart));
document.querySelectorAll('[data-close-cart]').forEach((el) => el.addEventListener('click', closeCart));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && drawer.classList.contains('is-open')) closeCart(); });
document.addEventListener('hm:open-cart', openCart);

async function render() {
  const body = drawer.querySelector('[data-cart-body]');
  const foot = drawer.querySelector('[data-cart-foot]');
  const lines = cart.lines();

  if (!lines.length) {
    body.replaceChildren(h('div', { class: 'cart-empty' },
      h('p', {}, 'Your bag is empty.'),
      h('a', { class: 'btn btn-primary', href: '/shop' }, 'Browse shoes')));
    foot.replaceChildren();
    return;
  }

  let data;
  try { data = await loadCatalogue(true); } catch {
    body.replaceChildren(h('p', { class: 'cart-empty' }, 'We could not load your bag. Please try again.'));
    return;
  }
  const rows = resolveLines(lines, data);
  const payable = rows.filter((r) => r.ok);
  const subtotal = payable.reduce((sum, r) => sum + r.product.price * r.qty, 0);

  body.replaceChildren(...rows.map(lineItem));
  foot.replaceChildren(
    h('p', { class: 'cart-total' }, h('span', {}, 'Subtotal'), h('strong', {}, kes(subtotal))),
    h('p', { class: 'fine' }, 'Delivery is added at checkout, based on your county.'),
    payable.length
      ? h('a', { class: 'btn btn-mpesa btn-block', href: '/checkout' }, 'Checkout with M-Pesa')
      : h('button', { class: 'btn btn-mpesa btn-block', type: 'button', disabled: true }, 'Checkout with M-Pesa'),
    h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: closeCart }, 'Continue shopping'));
}

function lineItem(row) {
  if (!row.product) {
    return h('div', { class: 'cart-line is-unavailable' },
      h('div', { class: 'cart-line-info' }, h('p', {}, 'This item is no longer in our collection.')),
      h('button', { class: 'link-btn', type: 'button', onclick: () => cart.remove(row.id, row.size) }, 'Remove'));
  }
  const max = Math.min(row.available, MAX_QTY);
  const note = row.available === 0 ? 'Sold out in this size'
    : row.available < row.qty ? `Only ${row.available} left in this size` : null;

  return h('div', { class: row.ok ? 'cart-line' : 'cart-line is-unavailable' },
    h('a', { class: 'cart-line-img', href: `/product?id=${encodeURIComponent(row.id)}` }, picture(row.product.images[0], { sizes: '88px' })),
    h('div', { class: 'cart-line-info' },
      h('a', { class: 'cart-line-name', href: `/product?id=${encodeURIComponent(row.id)}` }, row.product.name),
      h('p', { class: 'cart-line-meta' }, swatch(row.colour), `${row.colour.name} \u00b7 EU ${row.size}`),
      note ? h('p', { class: 'cart-line-note' }, note) : null,
      h('div', { class: 'cart-line-row' },
        h('div', { class: 'qty', role: 'group', 'aria-label': `Quantity for ${row.product.name}` },
          h('button', { class: 'qty-btn', type: 'button', 'aria-label': 'Decrease quantity', onclick: () => cart.setQty(row.id, row.size, row.qty - 1) }, '\u2212'),
          h('span', { 'aria-live': 'polite' }, String(row.qty)),
          h('button', { class: 'qty-btn', type: 'button', 'aria-label': 'Increase quantity', disabled: row.qty >= max, onclick: () => cart.setQty(row.id, row.size, row.qty + 1) }, '+')),
        h('strong', {}, kes(row.product.price * row.qty))),
      h('button', { class: 'link-btn', type: 'button', onclick: () => cart.remove(row.id, row.size) }, 'Remove')));
}

cart.subscribe(() => {
  updateBadge();
  if (drawer.classList.contains('is-open')) render();
});
updateBadge();
