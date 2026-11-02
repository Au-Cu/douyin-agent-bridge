// Patch only changed nodes. Keep native form focus, details state and scrollable
// descendants alive across polling; never recreate a whole live list.
const rendered = new WeakMap();
function key(node) {
  if (!node || node.nodeType !== 1) return null;
  for (const name of ['id', 'data-ui-key', 'data-operation', 'data-fold-key']) {
    if (node.hasAttribute(name)) return name + ':' + node.getAttribute(name);
  }
  return null;
}
const sameType = (a, b) => a?.nodeType === b.nodeType && a.nodeName === b.nodeName;
function patch(node, next) {
  if (node.nodeType !== 1) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return;
  }
  const focused = node === document.activeElement;
  const retained = name => (node.tagName === 'DETAILS' && name === 'open') ||
    (focused && ['value', 'checked', 'selected'].includes(name));
  for (const attr of [...node.attributes]) {
    if (!next.hasAttribute(attr.name) && !retained(attr.name)) node.removeAttribute(attr.name);
  }
  for (const attr of next.attributes) {
    if (!retained(attr.name) && node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
  }
  children(node, next);
}
function children(parent, next) {
  const keyed = new Map([...parent.childNodes].filter(n => key(n)).map(n => [key(n), n]));
  let cursor = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    const wanted = key(desired);
    let current = wanted ? keyed.get(wanted) : (!key(cursor) && sameType(cursor, desired) ? cursor : null);
    if (current && !sameType(current, desired)) current = null;
    if (!current) current = desired.cloneNode(true);
    if (current !== cursor) parent.insertBefore(current, cursor);
    patch(current, desired);
    cursor = current.nextSibling;
  }
  while (cursor) { const old = cursor; cursor = cursor.nextSibling; old.remove(); }
}
export function updateHTML(container, html, { animate = false } = {}) {
  if (rendered.get(container) === html) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const positions = animate && !reduced ? new Map([...container.children].map(n => [n, n.getBoundingClientRect().top])) : null;
  const template = document.createElement('template');
  template.innerHTML = html;
  children(container, template.content);
  rendered.set(container, html);
  if (positions) for (const child of container.children) {
    const old = positions.get(child), dy = old === undefined ? 0 : old - child.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) child.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 160, easing: 'ease-out' });
  }
}
// Options may be regenerated when a backend/model catalog changes, never just
// because the status poll fired. The caller retains the selected value.
export function updateOptions(select, html) {
  if (select.dataset.optionsHTML === html) return;
  select.innerHTML = html;
  select.dataset.optionsHTML = html;
}
