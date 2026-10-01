// Elements that can trigger SPA client-side routing without a real <a href>. Includes ARIA roles
// used by popover/listbox/grid items (option, row, treeitem, gridcell) plus bare <tr>/<li> so
// clickable table rows and list items (e.g. a user row that pushes to /user/123) are discoverable
// even when the framework wires the click handler without a literal onclick attribute — see
// isRowOrListCandidate() in page-helpers.js for how those bare tags get narrowed back down.
// Shared with the discovery layer so click-probing re-queries the exact same set/order.
export const NAV_CANDIDATE_SELECTOR =
  'button, input[type="button"], [role="link"], [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="row"], [role="treeitem"], [role="gridcell"], [aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded], [onclick], tr, li';

// Skip anything that sounds like it mutates/logs out rather than navigates.
export const DESTRUCTIVE_TEXT_RE = /delete|remove|logout|log out|sign out|deactivate|disable|unsubscribe|discard|revoke/i;

// Overlay/dialog elements checked after a nav-candidate click that didn't change the URL.
export const MODAL_SELECTOR =
  'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal.show, .modal.in, .ReactModal__Content, .MuiDialog-root, .MuiModal-root';

// Elements that disclose a hidden menu/dropdown/popover on click rather than navigating directly -
// identified via the two ARIA signals real widgets almost always expose regardless of framework,
// so a dedicated prober can open/close each one deliberately instead of stumbling into it as a
// side effect of generic nav-candidate clicking.
export const POPOVER_TRIGGER_SELECTOR = '[aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded="false"]';

// Tables and ARIA grids alike - shared between the quick per-screen table scan and the deeper
// virtualized-scroll pass so both index the same elements in the same order.
export const TABLE_SELECTOR = "table, [role='grid'], [role='table']";
