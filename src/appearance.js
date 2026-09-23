/* Restore the chosen palette before the page paints. */
(() => {
  let appearance = 'dark';
  try {
    const saved = JSON.parse(localStorage.getItem('threebody.appearance'));
    if (saved === 'light' || saved === 'dark') appearance = saved;
  } catch (_) { /* Storage may be unavailable or contain an invalid value. */ }
  document.documentElement.dataset.theme = appearance;
})();
