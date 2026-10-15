import './layout.js';
import { MAX_QTY, SIZES, cart, h, kes, loadCatalogue, loadConfig, picture, productCard, swatch } from './lib.js';

const root = document.querySelector('[data-pdp]');
const crumbs = document.querySelector('[data-crumbs]');
const relatedWrap = document.querySelector('[data-related-wrap]');
const relatedGrid = document.querySelector('[data-related]');

const FOOT_GUIDE = [[40, '25.0'], [41, '26.0'], [42, '26.5'], [43, '27.0'], [44, '28.0'], [45, '28.5']];

let data;
let config;
try {
  [data, config] = await Promise.all([loadCatalogue(), loadConfig()]);
} catch {
  root.replaceChildren(h('p', { class: 'muted' }, 'We could not load this pair. Please refresh the page.'));
  throw new Error('catalogue unavailable');
}

const product = data.products.find((p) => p.id === new URLSearchParams(location.search).get('id'));
root.removeAttribute('aria-busy');

if (!product) {
  root.replaceChildren(h('div', { class: 'empty-state wide' },
    h('h1', {}, 'We could not find that pair'),
    h('p', {}, 'It may have been sold or the link may be out of date.'),
    h('a', { class: 'btn btn-primary', href: '/shop' }, 'Back to the collection')));
} else {
  render(product);
}

function render(p) {
  const colour = data.colours.find((c) => c.id === p.colour);
  document.title = `${p.name}, ${colour.name} | HM`;
  crumbs.append(h('span', { 'aria-hidden': 'true' }, '/'), h('span', { 'aria-current': 'page' }, p.name));

  /* gallery */
  const stage = h('div', { class: 'pdp-main' });
  const thumbs = p.images.map((image, i) => h('button', {
    class: 'thumb', type: 'button', 'aria-label': `Show photo ${i + 1} of ${p.images.length}`, onclick: () => show(i),
  }, picture(image, { sizes: '96px' })));
  function show(i) {
    stage.replaceChildren(picture(p.images[i], { sizes: '(min-width: 900px) 50vw, 100vw', lazy: false, focus: false }));
    thumbs.forEach((button, n) => button.setAttribute('aria-current', String(n === i)));
  }
  show(0);

  /* sizes */
  let selected = 0;
  const hint = h('p', { class: 'size-hint', 'aria-live': 'polite' }, 'Choose your size');
  const problem = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const radios = SIZES.map((size) => {
    const available = p.sizes.find((s) => s.size === size)?.available ?? 0;
    const input = h('input', { type: 'radio', name: 'size', value: String(size), disabled: available === 0 });
    input.addEventListener('change', () => {
      selected = size;
      problem.hidden = true;
      hint.textContent = available <= 2 ? `Only ${available} left in EU ${size}` : `In stock in EU ${size}`;
    });
    return h('label', { class: 'size-opt' }, input, h('span', {}, String(size)));
  });
  const sizeSet = h('fieldset', { class: 'sizes' }, h('legend', {}, 'Size (EU)'), h('div', { class: 'size-grid' }, ...radios), hint);

  /* actions */
  function addToBag() {
    if (!selected) {
      problem.textContent = 'Please choose a size first.';
      problem.hidden = false;
      sizeSet.querySelector('input:not(:disabled)')?.focus();
      return 'none';
    }
    const available = p.sizes.find((s) => s.size === selected).available;
    const inBag = cart.lines().find((l) => l.id === p.id && l.size === selected)?.qty ?? 0;
    if (inBag >= Math.min(available, MAX_QTY)) {
      problem.textContent = 'You already have every available pair in this size in your bag.';
      problem.hidden = false;
      return 'full';
    }
    cart.add(p.id, selected);
    return 'added';
  }

  const soldOut = p.sizes.every((s) => s.available === 0);
  const actions = soldOut
    ? h('p', { class: 'form-error' }, 'Sold out. Browse similar pairs below.')
    : h('div', { class: 'pdp-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { if (addToBag() === 'added') document.dispatchEvent(new Event('hm:open-cart')); } }, 'Add to bag'),
        h('button', { class: 'btn btn-mpesa', type: 'button', onclick: () => { if (addToBag() !== 'none') location.href = '/checkout'; } }, 'Buy now with M-Pesa'));

  /* info panels */
  const cheapest = Math.min(...config.zones.map((z) => z.fee));
  const panels = h('div', { class: 'accordion' },
    h('details', { open: true }, h('summary', {}, 'Details'), h('ul', { class: 'plain' }, ...p.details.map((d) => h('li', {}, d)))),
    h('details', {}, h('summary', {}, 'Size guide'),
      h('p', {}, 'Men\u2019s EU sizes. If you are between sizes, choose the larger size. Approximate foot length:'),
      h('table', { class: 'fees compact' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'EU size'), h('th', { scope: 'col' }, 'Foot length'))),
        h('tbody', {}, ...FOOT_GUIDE.map(([size, cm]) => h('tr', {}, h('th', { scope: 'row' }, String(size)), h('td', {}, `${cm} cm`)))))),
    h('details', {}, h('summary', {}, 'Delivery and payment'),
      h('p', {}, `We deliver across Kenya. Delivery starts from ${kes(cheapest)} and is added at checkout based on your county.`),
      h('p', {}, 'Pay with M-Pesa only: you approve a payment request on your phone with your PIN. We do not accept cards or cash on delivery.')));

  const info = h('div', { class: 'pdp-info' },
    h('p', { class: 'eyebrow' }, p.style),
    h('h1', { class: 'pdp-title' }, p.name),
    h('p', { class: 'pdp-price' }, kes(p.price)),
    h('p', { class: 'pdp-meta' }, swatch(colour), `${colour.name}`, h('span', { class: 'sep', 'aria-hidden': 'true' }, '\u00b7'), `Condition: ${p.condition}`),
    h('p', { class: 'pdp-desc' }, p.description),
    sizeSet, problem, actions,
    h('ul', { class: 'pdp-trust' },
      h('li', {}, 'Made in Italy'),
      h('li', {}, 'Pay with M-Pesa, no card needed'),
      h('li', {}, `Delivery across Kenya from ${kes(cheapest)}`)),
    panels);

  root.replaceChildren(
    h('div', { class: 'pdp-gallery' }, stage, thumbs.length > 1 ? h('div', { class: 'pdp-thumbs' }, ...thumbs) : null),
    info);

  /* related */
  const others = data.products.filter((o) => o.id !== p.id)
    .sort((a, b) => Number(b.colour === p.colour) - Number(a.colour === p.colour) || Number(b.style === p.style) - Number(a.style === p.style));
  relatedGrid.replaceChildren(...others.slice(0, 4).map((o) => productCard(o, data.colours)));
  relatedWrap.hidden = false;
}
