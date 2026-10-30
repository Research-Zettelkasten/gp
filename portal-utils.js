/* GlassPro common display and time utilities. These are client-side helpers,
 * NOT authentication, authorization, or Supabase row-level security. */
(function (root) {
  "use strict";
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[c]));
  const csvCell = value => {
    let s = String(value ?? "");
    // Spreadsheet applications evaluate leading =, +, -, @, or tab as formulas.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const localDate = (date = new Date()) => {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, "0")}-${String(d.getDate()).padStart(2,"0")}`;
  };
  const weekStart = (date = new Date()) => {
    const d = new Date(date); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay()+6)%7)); // Monday
    return d;
  };
  const isInCurrentWeek = (value, now = new Date()) => {
    if (typeof value !== "string") return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const d = new Date(+m[1], +m[2]-1, +m[3]);
    if (localDate(d) !== value) return false;
    const start = weekStart(now), end = new Date(start);
    end.setDate(end.getDate()+7);
    return d >= start && d < end;
  };
  const addLocalDays = (amount, from = new Date()) => {
    const d = new Date(from); d.setDate(d.getDate() + amount);
    return localDate(d);
  };
  root.GP = Object.freeze({ escapeHtml, csvCell, localDate, weekStart, isInCurrentWeek, addLocalDays });
})(typeof window !== "undefined" ? window : globalThis);
