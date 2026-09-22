/**
 * Click a column heading to sort a report table by it; click again to
 * reverse. Only tables marked `data-sortable` take part (the reports,
 * src/admin/reports.tsx).
 *
 * Sorting happens in the browser, over rows the server has already sent,
 * which is why the report pages send every row rather than a page of them:
 * sorting one page of a hundred would look like sorting the report while
 * quietly sorting a slice of it. A few thousand rows is a comfortable page.
 * Anyone wanting more than a sort -- pivots, joins, charts of their own --
 * has the CSV link above each table.
 *
 * A cell sorts by its `data-sort` attribute when it has one (a month's
 * number, rather than its name) and by its text otherwise. Text compares
 * numerically where it holds numbers, so order 1000 follows order 999, and
 * ISO dates sort as dates for free. Empty cells go last whichever way the
 * column is sorted -- a column of blanks at the top reads as a broken table.
 * The sort is stable, so rows that tie keep the server's order.
 *
 * Headings become buttons, so the sort is reachable by keyboard, and
 * `aria-sort` tells a screen reader which column is sorted and which way.
 * Without JavaScript the tables are exactly what the server sent.
 */
export const TABLE_SORT_SCRIPT = `
(function () {
  var collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  function sortValue(row, index) {
    var cell = row.cells[index];
    if (!cell) return "";
    var value = cell.getAttribute("data-sort");
    return value === null ? cell.textContent.trim() : value;
  }
  document.querySelectorAll("table[data-sortable]").forEach(function (table) {
    if (!table.tHead) return;
    var headings = Array.prototype.slice.call(table.tHead.rows[0].cells);
    headings.forEach(function (heading, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "sort";
      button.textContent = heading.textContent;
      heading.textContent = "";
      heading.appendChild(button);
      button.addEventListener("click", function () {
        var ascending = heading.getAttribute("aria-sort") !== "ascending";
        headings.forEach(function (other) { other.removeAttribute("aria-sort"); });
        heading.setAttribute("aria-sort", ascending ? "ascending" : "descending");
        Array.prototype.forEach.call(table.tBodies, function (body) {
          var rows = Array.prototype.slice.call(body.rows);
          rows.sort(function (a, b) {
            var x = sortValue(a, index);
            var y = sortValue(b, index);
            if (x === "" || y === "") return (x === "" ? 1 : 0) - (y === "" ? 1 : 0);
            var order = collator.compare(x, y);
            return ascending ? order : -order;
          });
          rows.forEach(function (row) { body.appendChild(row); });
        });
      });
    });
  });
})();
`;
