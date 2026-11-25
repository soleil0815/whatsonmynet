// Picking rows for "several at once" (inventory, monitoring). A click that misses the small box must not open the
// device or monitor and throw the selection away:
// - once something is picked, a click anywhere in a row picks or unpicks it - opened is only by the name (a link)
// - the whole cell around the box picks, not only the box itself
// - the picked rows survive opening one and coming back (per browser tab)

/**
 * The click of a row with a pick box: true when it was handled as picking (the caller then does not open anything).
 * Clicks on links, buttons and form fields keep their own meaning.
 */
export function pickClick(e, box, picking) {
  if (!box || box.disabled) return false;
  if (e.target.closest('a,button,input,label,select,textarea')) return e.target.closest('td.pick-cell') !== null && e.target === box;
  if (!picking && !e.target.closest('td.pick-cell')) return false;
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/** The picked ids of a list, kept for this browser tab (key: e.g. 'pick.inventory') */
export function pickedSet(key) {
  let ids = [];
  try { ids = JSON.parse(sessionStorage.getItem(key) || '[]'); } catch { ids = []; }
  const set = new Set(Array.isArray(ids) ? ids.filter((x) => Number.isInteger(x)).slice(0, 5000) : []);
  const save = () => { try { sessionStorage.setItem(key, JSON.stringify([...set])); } catch { /* storage not allowed */ } };
  // the set saves itself on every change
  for (const m of ['add', 'delete', 'clear']) {
    const orig = set[m].bind(set);
    set[m] = (...a) => { const r = orig(...a); save(); return r; };
  }
  return set;
}
