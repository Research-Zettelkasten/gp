# Lunch review weeks

Lunch Exception Review has its own week selector in **Management → Time & Geotags**. Payroll and employee shift history continue to use their existing Monday–Sunday weeks.

The default lunch review view also groups shifts Monday–Sunday by their recorded work date, including Sunday overnight shifts. Its default changes every **Tuesday at 12:00 AM America/New_York**. On Monday, the prior week remains selected for weekend follow-up.

For example:

| When the portal is opened | Current lunch review week |
| --- | --- |
| Sunday, November 22, 2026 | November 16–22 |
| Monday, November 23, 2026 | November 16–22 |
| Tuesday, November 24, 2026 | November 23–29 |

An open portal follows the Tuesday rollover during its normal background refresh. Returning to a browser tab also checks the review period. Boundaries use Eastern time even if the browser is in another timezone, including daylight saving and year changes.

- **Previous week / Next week:** move through review periods, up to the current calendar week. Monday's new submissions can be selected before the default advances Tuesday.
- **Jump to a date:** open the Monday–Sunday period containing that date.
- **Current review week:** resume following the Tuesday rollover. Selecting a historical week keeps that selection during refreshes and rollover; reloading the portal returns to the current review week.
- **All outstanding:** show pending and rejected cases from all weeks, including legacy records without a valid work date. This view displays the total unresolved count.
- **Refresh Review Queue:** fetch the latest available records. Unchanged rows are retained during background updates.

The pending badge and correction count describe the displayed view. In weekly mode, the summary also shows how many outstanding cases are outside that week. Approved cases remain in timecard history. Changing the selected period never approves, rejects, changes hours, or deletes an exception; existing review permissions and audit behavior still apply.

This is a frontend update and requires **no additional SQL**. Previously required timekeeping migrations are unchanged.
