// Applies the theme before the page is drawn (no flash). The stored choice comes from the user's account; light by default.
(function () {
  var pref = 'light';
  try { pref = localStorage.getItem('womn-theme') || 'light'; } catch (e) { /* storage blocked */ }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
