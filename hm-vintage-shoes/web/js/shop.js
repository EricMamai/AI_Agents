import './layout.js';
import { SIZES, h, loadCatalogue, productCard, swatch } from './lib.js';

const form = document.querySelector('[data-filters]');
const grid = document.querySelector('[data-grid]');
const countLabel = document.querySelector('[data-result-count]');

const SORTS = [
  ['featured', 'Featured'],
  ['price-asc', 'Price: low to high'],
  ['price-desc', 'Price: high to low'],
];

const params = new URLSearchParams(location.search);
const state = {
  colour: params.get('colour') || '',
  style: params.get('style') || '',
  size: SIZES.includes(Number(params.get('size'))) ? Number(params.get('size')) : 0,
  sort: SORTS.some(([key]) => key === params.get('sort')) ? params.get('sort') : 'featured',
};

form.addEventListener('submit', (event) => event.preventDefault());

let data;
try {
  data = await loadCatalogue();
} catch {
  grid.replaceChildren(h('p', { class: 'muted' }, 'We could not load the collection. Please refresh the page.'));
  throw new Error('catalogue unavailable');
}

const styles = [...new Set(data.products.map((p) => p.style))].sort();
const chips = [];
let sortSelect;
let clearButton;

function clearFilters() {
  Object.assign(state, { colour: '', style: '', size: 0 });
  update();
}

function chip(label, key, value, extra) {
  const el = h('button', { class: 'chip', type: 'button', onclick: () => { state[key] = value; update(); } }, extra, label);
  chips.push({ el, key, value });
  return el;
}

function group(title, ...items) {
  return h('fieldset', { class: 'filter-group' }, h('legend', {}, title), h('div', { class: 'chips' }, ...items));
}

function buildFilters() {
  sortSelect = h('select', { onchange: (event) => { state.sort = event.target.value; update(); } },
    ...SORTS.map(([key, label]) => h('option', { value: key }, label)));
  clearButton = h('button', { class: 'link-btn', type: 'button', onclick: clearFilters }, 'Clear filters');

  form.replaceChildren(
    group('Colour', chip('All', 'colour', ''), ...data.colours.map((c) => chip(c.name, 'colour', c.id, swatch(c)))),
    group('Style', chip('All', 'style', ''), ...styles.map((s) => chip(s, 'style', s))),
    group('Size (EU)', chip('Any', 'size', 0), ...SIZES.map((s) => chip(String(s), 'size', s))),
    h('div', { class: 'filter-bar' }, h('label', { class: 'sort' }, h('span', {}, 'Sort by'), sortSelect), clearButton));
}

function syncUrl() {
  const next = new URLSearchParams();
  if (state.colour) next.set('colour', state.colour);
  if (state.style) next.set('style', state.style);
  if (state.size) next.set('size', state.size);
  if (state.sort !== 'featured') next.set('sort', state.sort);
  const query = next.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

function visibleProducts() {
  const list = data.products.filter((p) =>
    (!state.colour || p.colour === state.colour)
    && (!state.style || p.style === state.style)
    && (!state.size || p.sizes.some((s) => s.size === state.size && s.available > 0)));
  if (state.sort === 'price-asc') list.sort((a, b) => a.price - b.price);
  if (state.sort === 'price-desc') list.sort((a, b) => b.price - a.price);
  return list;
}

function update() {
  for (const { el, key, value } of chips) el.setAttribute('aria-pressed', String(state[key] === value));
  clearButton.hidden = !(state.colour || state.style || state.size);
  sortSelect.value = state.sort;
  syncUrl();

  const list = visibleProducts();
  const colour = data.colours.find((c) => c.id === state.colour);
  countLabel.textContent = `${list.length} ${list.length === 1 ? 'pair' : 'pairs'}${colour ? ` in ${colour.name}` : ''}${state.size ? ` in EU ${state.size}` : ''}`;

  grid.removeAttribute('aria-busy');
  grid.replaceChildren(...(list.length
    ? list.map((p) => productCard(p, data.colours))
    : [h('div', { class: 'empty-state wide' },
        h('h2', {}, 'No pairs match these filters'),
        h('p', {}, 'Try another colour, style or size.'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: clearFilters }, 'Clear filters'))]));
}

buildFilters();
update();
