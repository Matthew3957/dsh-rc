'use strict';
// Themes: a colour scheme chosen per device. Loaded as a plain script in <head>, before first
// paint, so the saved theme is on <html data-theme> before anything is drawn. The colours
// themselves live in style.css as token overrides; this file only picks one, remembers it and
// keeps the iOS status-bar colour (the theme-color meta tags) in step with the page background.
// Every theme follows the device's light or dark setting.
(function () {
  const KEY = 'dsh-rc.theme';
  // `bg` is each theme's --bg, as [light, dark]; test/theme-contrast.test.mjs keeps them equal
  // to style.css. `swatch` is what Settings > Appearance paints for a theme: its page (--bg),
  // card surface (--card) and accent (--accent), in the light and the dark scheme. The same test
  // keeps those equal to style.css too.
  const sw = (light, dark) => ({ light: { bg: light[0], card: light[1], accent: light[2] }, dark: { bg: dark[0], card: dark[1], accent: dark[2] } });
  const THEMES = [
    { id: 'default', label: 'Default', hint: 'The standard look', bg: ['#f6f7f8', '#111416'],
      swatch: sw(['#f6f7f8', '#ffffff', '#0e7c86'], ['#111416', '#1e2327', '#3cc4c4']) },
    { id: 'colourblind', label: 'Colourblind-safe', hint: 'Blue and orange, no red against green', bg: ['#f7f7f5', '#121417'],
      swatch: sw(['#f7f7f5', '#ffffff', '#0a679b'], ['#121417', '#21252a', '#56b4e9']) },
    { id: 'contrast', label: 'High contrast', hint: 'Black and white, strong borders', bg: ['#ffffff', '#000000'],
      swatch: sw(['#ffffff', '#ffffff', '#0033cc'], ['#000000', '#0a0a0a', '#7fd0ff']) },
    { id: 'autumn', label: 'Autumn', hint: 'Warm paper and rust', bg: ['#f8f3ec', '#181311'],
      swatch: sw(['#f8f3ec', '#fffcf7', '#a8481c'], ['#181311', '#281f1a', '#e8905a']) },
    { id: 'winter', label: 'Winter', hint: 'Cool slate and ice', bg: ['#f3f6f9', '#0f151b'],
      swatch: sw(['#f3f6f9', '#ffffff', '#2a65a8'], ['#0f151b', '#1b242d', '#7db4ee']) },
    { id: 'spring', label: 'Spring', hint: 'Soft sage and blossom', bg: ['#f4f7f1', '#121612'],
      swatch: sw(['#f4f7f1', '#fdfefb', '#34694a'], ['#121612', '#1e251d', '#8cc98e']) },
    { id: 'mission', label: 'Mission Tile', hint: 'Warm paper, ink and tile red, set in a book serif', bg: ['#fbf8f4', '#1a1512'],
      swatch: sw(['#fbf8f4', '#ffffff', '#9c4732'], ['#1a1512', '#2a231e', '#e08a6e']) },
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
