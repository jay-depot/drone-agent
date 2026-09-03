/**
 * Compute the "13-24 of 95" range indicator for a paginated view.
 *
 * @param offset Number of items skipped before this page (0-based).
 * @param pageSize Number of items per page.
 * @param total Total number of items across all pages.
 */
export function paginationRange(
  offset: number,
  pageSize: number,
  total: number
): string {
  if (total <= 0) return '0 of 0';
  const start = Math.min(offset + 1, total);
  const end = Math.min(offset + pageSize, total);
  return start === end ? `${start} of ${total}` : `${start}-${end} of ${total}`;
}
