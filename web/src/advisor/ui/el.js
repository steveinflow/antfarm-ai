// Tiny DOM helper used throughout the AdvisorPanel views.
// Accepts attrs (className/htmlFor/style/on*… plain attributes) and a
// flat or nested children list. Strings become text nodes; arrays are
// expanded; nullish children are skipped.

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') { node.className = v; }
      else if (k === 'htmlFor') { node.htmlFor = v; }
      else if (k === 'style' && typeof v === 'object') { Object.assign(node.style, v); }
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, v);
      }
    }
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else if (Array.isArray(c)) c.forEach(ch => ch && node.appendChild(ch));
    else node.appendChild(c);
  }
  return node;
}
