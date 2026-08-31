/**
 * Persian digit presentation layer.
 *
 * The app must render every number with Persian (Eastern Arabic) digits when
 * the active locale is `fa`. Rather than touching hundreds of call sites, we
 * transliterate rendered text nodes in place and keep them in sync with a
 * MutationObserver. Input values, code blocks and anything explicitly opted
 * out with `data-latin-digits` are left untouched.
 */

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const ASCII_DIGIT_RE = /[0-9]/g;

export function toPersianDigits(value: string): string {
  return value.replace(ASCII_DIGIT_RE, (d) => FA_DIGITS[Number(d)]);
}

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'NOSCRIPT',
]);

function shouldSkip(node: Node | null): boolean {
  let el: HTMLElement | null =
    node?.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node?.parentElement ?? null;
  while (el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute?.('data-latin-digits')) return true;
    el = el.parentElement;
  }
  return false;
}

function convertTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    convertTextNode(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (shouldSkip(root)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    convertTextNode(current as Text);
    current = walker.nextNode();
  }
}

function convertTextNode(node: Text): void {
  const text = node.nodeValue;
  if (!text || !/[0-9]/.test(text)) return;
  if (shouldSkip(node)) return;
  const next = toPersianDigits(text);
  if (next !== text) node.nodeValue = next;
}

let observer: MutationObserver | null = null;

export function installPersianDigits(): void {
  if (observer || typeof document === 'undefined') return;
  convertTree(document.body);
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') {
        convertTextNode(record.target as Text);
      } else {
        record.addedNodes.forEach(convertTree);
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

export function uninstallPersianDigits(): void {
  observer?.disconnect();
  observer = null;
}
