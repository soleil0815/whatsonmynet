// One CSV cell (semicolon separated, opened in Excel/LibreOffice): text never runs as a formula.
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Formula injection: a cell starting with = + - @ (also after leading spaces, tabs or line breaks), starting with a
  // tab or CR, or holding a comma followed by one of them (Excel with comma as list separator splits the cell there)
  // is shown as text in spreadsheets. Every column is text (dates are ISO strings), so "-5" becomes text as well.
  if (/^[\t\r]|^\s*[=+\-@]|,\s*[=+\-@]/.test(s)) s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
