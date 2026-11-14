// Which results of a scan can be acted on. Results of an older scan (a newer scan of the same subnet has covered them,
// r.outdated) can be looked at but not adopted or ignored - the server refuses that (err.scanOutdated). Stopping to
// ignore works for any scan, so in the "ignored" tab every row stays selectable.

/** Row can be ticked in the tab ('new' = adopt/ignore, 'ignored' = stop ignoring or adopt) */
export const selectableRow = (r, mode) => mode === 'ignored' || !r.outdated;

/** The ticked rows can be adopted: none of them is from an outdated scan */
export const canAdopt = (rows) => rows.length > 0 && rows.every((r) => !r.outdated);
