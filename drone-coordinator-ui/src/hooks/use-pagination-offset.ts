import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Read and write the pagination `offset` query parameter. Pushing a new offset
 * writes a history entry (react-router's default), so navigating into an item
 * and pressing Back returns to the same page of results. An offset of 0 is
 * omitted from the URL to keep the first page's URL clean.
 *
 * @param pageSize Number of items per page, used to validate the offset.
 */
export function usePaginationOffset(pageSize: number): {
  offset: number;
  setOffset: (offset: number) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();

  const raw = Number(searchParams.get('offset') ?? '0');
  const offset = Number.isFinite(raw) && raw >= 0 ? raw : 0;
  const page = Math.floor(offset / pageSize);
  const clamped = page * pageSize;

  const setOffset = useCallback(
    (nextOffset: number) => {
      const params = new URLSearchParams(searchParams);
      if (nextOffset <= 0) {
        params.delete('offset');
      } else {
        params.set('offset', String(nextOffset));
      }
      setSearchParams(params);
    },
    [searchParams, setSearchParams]
  );

  return { offset: clamped, setOffset };
}
