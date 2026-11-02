// A per-browser presentation preference; never modifies saved assistant data.
// This synchronous external script also runs on the classic entry point and is
// allowed by the console's self-only Content Security Policy.
(() => {
  const current = document.documentElement.dataset.layout || 'modern';
  const valid = value => value === 'modern' || value === 'classic';
  const url = new URL(location.href);
  let preferred = url.searchParams.get('ui');
  if (!valid(preferred)) { try { preferred = localStorage.getItem('bridge-ui-layout'); } catch {} }
  if (valid(preferred) && preferred !== current) {
    url.pathname = preferred === 'classic' ? '/classic.html' : '/';
    location.replace(url.href);
    return;
  }
  if (valid(preferred)) try { localStorage.setItem('bridge-ui-layout', preferred); } catch {}
  window.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('uiLayoutChoice');
    if (!select) return;
    select.value = current;
    select.addEventListener('change', () => {
      const next = select.value;
      if (!valid(next) || next === current) return;
      if (!window.dispatchEvent(new Event('bridge-layout-change', { cancelable: true }))) { select.value = current; return; }
      try { localStorage.setItem('bridge-ui-layout', next); } catch {}
      const target = new URL(location.href);
      target.pathname = next === 'classic' ? '/classic.html' : '/';
      target.searchParams.set('ui', next);
      location.assign(target.href);
    });
  });
})();
