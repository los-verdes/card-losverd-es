/**
 * Type to narrow a report table to the rows that mention it, in any column.
 * Only tables inside a `data-table-filter` scope take part (every report
 * table, src/admin/reports.tsx); the scope also holds the box and the count.
 *
 * Like sorting (src/admin/tableSort.ts), this works in the browser over the
 * rows the server already sent, so it answers as fast as someone types and
 * never puts what they typed into a URL, where it would reach the logs. It
 * narrows what is on screen only: the CSV link still downloads the report.
 *
 * Every word typed must appear somewhere in the row, ignoring case, so
 * "smith 2024" finds a Smith whose membership started or ended in 2024. A
 * row's text is what its cells show, plus any `data-sort` value, and is read
 * once, the first time the box is used. Rows are hidden rather than removed,
 * so a sort afterwards still sorts all of them and the filter still holds.
 *
 * A table's footer (the orders report's totals) is hidden while a filter is
 * on: it adds up the whole table, and under a filtered one it would read as
 * the total of the rows showing.
 *
 * The box is sent `hidden` and revealed here, so without JavaScript nobody
 * is offered a box that does nothing.
 */
export const TABLE_FILTER_SCRIPT = `
(function () {
  document.querySelectorAll("[data-table-filter]").forEach(function (scope) {
    var box = scope.querySelector("input[type=search]");
    var count = scope.querySelector("[data-filter-count]");
    var table = scope.querySelector("table");
    if (!box || !table) return;
    var texts = null;
    function rowText(row) {
      return Array.prototype.map.call(row.cells, function (cell) {
        return cell.textContent + " " + (cell.getAttribute("data-sort") || "");
      }).join(" ").toLowerCase();
    }
    function apply() {
      var rows = [];
      Array.prototype.forEach.call(table.tBodies, function (body) {
        Array.prototype.push.apply(rows, body.rows);
      });
      if (!texts) {
        texts = new Map();
        rows.forEach(function (row) { texts.set(row, rowText(row)); });
      }
      var words = box.value.toLowerCase().split(/\\s+/).filter(Boolean);
      var shown = 0;
      rows.forEach(function (row) {
        var text = texts.get(row) || "";
        var match = words.every(function (word) { return text.indexOf(word) !== -1; });
        row.hidden = !match;
        if (match) shown++;
      });
      if (table.tFoot) table.tFoot.hidden = words.length > 0;
      if (count) count.textContent = words.length ? shown + " of " + rows.length + " rows" : "";
    }
    box.addEventListener("input", apply);
    scope.querySelectorAll("[hidden][data-filter-control]").forEach(function (control) {
      control.hidden = false;
    });
    if (box.value) apply();
  });
})();
`;
