/*
** Just enough of the DOM to run the popup against the real popup.html.
**
** Elements are created from the tags in the file that carry an id, a
** data-i18n attribute or name="scope"; nesting is not modeled because the
** popup never traverses it. This keeps the HTML and the script honest with
** each other: a renamed id or a missing data-i18n key fails the tests.
*/
import fs from 'node:fs';

class ClassList {
  constructor(element) { this.element = element; }
  get set() { return new Set(this.element.className.split(/\s+/).filter(Boolean)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const set = this.set;
    const on = force ?? !set.has(name);
    if (on) set.add(name); else set.delete(name);
    this.element.className = [...set].join(' ');
    return on;
  }
}

export class FakeElement {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this.id = attributes.id ?? '';
    this.className = attributes.class ?? '';
    this.dataset = {};
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
    }
    this.name = attributes.name ?? '';
    this.value = attributes.value ?? '';
    this.checked = 'checked' in attributes;
    this.disabled = false;
    this.open = false;
    this.returnValue = '';
    this.textContent = '';
    this.children = [];
    this.listeners = {};
    this.classList = new ClassList(this);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  /* Fire an event and wait for async handlers. */
  async dispatch(type) { await Promise.all((this.listeners[type] ?? []).map(fn => fn({ type, target: this }))); }
  replaceChildren(...children) { this.children = children; }
  /* <dialog>: close() fires 'close' like the browser; the returned promise waits for handlers. */
  showModal() { this.open = true; }
  close(returnValue) {
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    return this.dispatch('close');
  }
}

export function fakeDocument(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const elements = [];
  for (const [, tag, rest] of html.matchAll(/<([a-z0-9]+)\b([^>]*)>/g)) {
    const attributes = Object.fromEntries(
      [...rest.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, name, value = '']) => [name, value]),
    );
    if (attributes.id || attributes['data-i18n'] || attributes.name === 'scope') {
      elements.push(new FakeElement(tag, attributes));
    }
  }
  return {
    elements,
    title: '',
    documentElement: { lang: '' },
    getElementById: id => elements.find(el => el.id === id) ?? null,
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return elements.filter(el => 'i18n' in el.dataset);
      if (selector === 'input[name="scope"]') {
        return elements.filter(el => el.tagName === 'INPUT' && el.name === 'scope');
      }
      throw new Error(`fake DOM does not support selector ${selector}`);
    },
    createElement: tag => new FakeElement(tag),
  };
}
