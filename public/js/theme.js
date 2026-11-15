// Applies the theme before the page is drawn (no flash). The stored choice comes from the user's account; by default the
// look follows the system (light or dark as the computer or phone is set).
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('womn-theme') || 'system'; } catch (e) { /* storage blocked */ }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
