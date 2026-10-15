import './layout.js';
import { h, kes, loadCatalogue, loadConfig, productCard } from './lib.js';

const featured = document.querySelector('[data-featured]');
const zones = document.querySelector('[data-zones]');

try {
  const [data, config] = await Promise.all([loadCatalogue(), loadConfig()]);

  const picks = data.products.filter((p) => p.featured).slice(0, 4);
  featured.replaceChildren(...picks.map((p) => productCard(p, data.colours)));
  featured.removeAttribute('aria-busy');

  for (const colour of data.colours) {
    const pairs = data.products
      .filter((p) => p.colour === colour.id)
      .reduce((n, p) => n + p.sizes.reduce((sum, s) => sum + s.available, 0), 0);
    const label = document.querySelector(`[data-colour-tile="${colour.id}"] [data-count]`);
    if (label) label.textContent = pairs ? `${pairs} pairs available` : 'Sold out';
  }

  zones.replaceChildren(...config.zones.map((z) => h('tr', {},
    h('th', { scope: 'row' }, h('strong', {}, z.label), h('small', {}, z.areas)),
    h('td', {}, kes(z.fee)),
    h('td', {}, z.eta))));
} catch {
  featured.replaceChildren(h('p', { class: 'muted' }, 'We could not load the collection. Please refresh the page.'));
}
