export const SIZES = [40, 41, 42, 43, 44, 45];
export const MAX_QTY = 3;

export const kes = (amount) => `KSh ${Number(amount).toLocaleString('en-KE')}`;

/** Tiny DOM builder. Text is always inserted as text nodes, never as HTML. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'vars') for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child);
  }
  return el;
}

export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  let data = null;
  try { data = await response.json(); } catch { /* empty body */ }
  if (!response.ok) {
    const error = new Error((data && data.error) || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

let catalogue;
export function loadCatalogue(fresh = false) {
  if (!catalogue || fresh) catalogue = api('/api/products');
  return catalogue;
}

let config;
export function loadConfig() {
  config ??= api('/api/config');
  return config;
}

/* ------------------------------------------------------------------ images */

export const photo = (id, width = 1200) => `/img/p/${id}-${width}.jpg`;

export function picture(image, { sizes = '100vw', lazy = true, className, focus = true } = {}) {
  const el = h('img', {
    class: className,
    src: photo(image.photo, 1200),
    srcset: `${photo(image.photo, 600)} 600w, ${photo(image.photo, 1200)} 1200w`,
    sizes,
    alt: image.alt || '',
    loading: lazy ? 'lazy' : null,
    decoding: 'async',
  });
  if (focus && image.focus) el.style.objectPosition = image.focus;
  return el;
}

/* -------------------------------------------------------------------- bag */

const KEY = 'hm_bag_v1';
const listeners = new Set();

const validLine = (l) => l && typeof l.id === 'string' && SIZES.includes(l.size) && Number.isInteger(l.qty) && l.qty > 0;

function read() {
  try {
    const lines = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(lines) ? lines.filter(validLine) : [];
  } catch { return []; }
}

function write(lines) {
  try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* storage unavailable */ }
  listeners.forEach((fn) => fn(lines));
}

export const cart = {
  lines: read,
  count: () => read().reduce((n, l) => n + l.qty, 0),
  add(id, size, qty = 1) {
    const lines = read();
    const hit = lines.find((l) => l.id === id && l.size === size);
    if (hit) hit.qty = Math.min(hit.qty + qty, MAX_QTY);
    else lines.push({ id, size, qty: Math.min(qty, MAX_QTY) });
    write(lines);
  },
  setQty(id, size, qty) {
    const lines = read().map((l) => (l.id === id && l.size === size ? { ...l, qty } : l)).filter((l) => l.qty > 0);
    write(lines);
  },
  remove(id, size) { write(read().filter((l) => !(l.id === id && l.size === size))); },
  clear() { write([]); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

window.addEventListener('storage', (event) => {
  if (event.key === KEY) listeners.forEach((fn) => fn(read()));
});

/** Join bag lines with the live catalogue (price, name, stock). */
export function resolveLines(lines, catalogueData) {
  return lines.map((line) => {
    const product = catalogueData.products.find((p) => p.id === line.id);
    const slot = product && product.sizes.find((s) => s.size === line.size);
    const available = slot ? slot.available : 0;
    const colour = product && catalogueData.colours.find((c) => c.id === product.colour);
    return { ...line, product, colour, available, ok: Boolean(product) && available >= line.qty };
  });
}

/* ------------------------------------------------------------------- misc */

export function swatch(colour) {
  return h('span', { class: 'dot', vars: { '--dot': colour.hex }, 'aria-hidden': 'true' });
}

export function productCard(product, colours) {
  const colour = colours.find((c) => c.id === product.colour);
  const left = product.sizes.reduce((n, s) => n + s.available, 0);
  const badge = left === 0 ? h('span', { class: 'badge badge-dark' }, 'Sold out')
    : left <= 2 ? h('span', { class: 'badge' }, `Only ${left} left`) : null;
  return h('article', { class: left === 0 ? 'card is-sold' : 'card' },
    h('a', { class: 'card-link', href: `/product?id=${encodeURIComponent(product.id)}` },
      h('div', { class: 'card-media' },
        picture(product.images[0], { sizes: '(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw' }),
        badge),
      h('div', { class: 'card-body' },
        h('p', { class: 'card-meta' }, swatch(colour), `${colour.name} \u00b7 ${product.style}`),
        h('h3', { class: 'card-name' }, product.name),
        h('p', { class: 'card-price' }, kes(product.price)))));
}

let toastTimer;
export function toast(message) {
  const el = document.querySelector('[data-toast]');
  if (!el) return;
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2800);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Same rule as the server: Kenyan mobile, 07xx / 01xx / +2547xx / +2541xx. */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/[\s\-().]/g, '');
  const match = digits.match(/^(?:\+?254|0)?([17]\d{8})$/);
  return match ? `254${match[1]}` : null;
}
