'use strict';
// Themes: a colour scheme chosen per device. Loaded as a plain script in <head>, before first
// paint, so the saved theme is on <html data-theme> before anything is drawn. The colours
// themselves live in style.css as token overrides; this file only picks one, remembers it and
// keeps the iOS status-bar colour (the theme-color meta tags) in step with the page background.
// Every theme follows the device's light or dark setting.
(function () {
  const KEY = 'dsh-rc.theme';
  // `bg` is each theme's --bg, as [light, dark]; test/theme-contrast.test.mjs keeps them equal
  // to style.css.
  const THEMES = [
    { id: 'default', label: 'Default', hint: 'The standard look', bg: ['#f6f7f8', '#111416'] },
    { id: 'colourblind', label: 'Colourblind-safe', hint: 'Blue and orange, no red against green, with shape cues', bg: ['#f7f7f5', '#121417'] },
    { id: 'contrast', label: 'High contrast', hint: 'Black and white, strong borders', bg: ['#ffffff', '#000000'] },
    { id: 'autumn', label: 'Autumn', hint: 'Warm paper and rust', bg: ['#f8f3ec', '#181311'] },
    { id: 'winter', label: 'Winter', hint: 'Cool slate and ice', bg: ['#f3f6f9', '#0f151b'] },
    { id: 'spring', label: 'Spring', hint: 'Soft sage and blossom', bg: ['#f4f7f1', '#121612'] },
  ];
  const byId = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

  function stored() {
    try { return byId(localStorage.getItem(KEY)).id; } catch { return 'default'; }
  }

  function apply(id) {
    const theme = byId(id);
    const root = document.documentElement;
    if (theme.id === 'default') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme.id);
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      const dark = /dark/.test(meta.getAttribute('media') || '');
      meta.setAttribute('content', theme.bg[dark ? 1 : 0]);
    }
    return theme.id;
  }

  // Returns false when the browser refused to store it: the theme still applies until a reload.
  function set(id) {
    const applied = apply(id);
    try {
      if (applied === 'default') localStorage.removeItem(KEY); else localStorage.setItem(KEY, applied);
      return true;
    } catch { return false; }
  }

  const api = { THEMES, KEY, current: stored, set, apply };
  if (typeof window !== 'undefined') window.dshTheme = api;
  apply(stored());
})();
