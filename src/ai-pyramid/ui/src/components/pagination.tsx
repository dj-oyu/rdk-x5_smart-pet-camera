type PaginationProps = {
  total: number;
  limit: number;
  offset: number;
  onPageChange: (offset: number) => void;
};

export function Pagination({ total, limit, offset, onPageChange }: PaginationProps) {
  if (total <= limit) return null;

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <nav class="pagination">
      <button
        type="button"
        class="pagination-btn"
        disabled={currentPage <= 1}
        onClick={() => onPageChange(Math.max(0, offset - limit))}
      >
        &lsaquo; Prev
      </button>
      <span class="pagination-info">
        {currentPage} / {totalPages}
      </span>
      <button
        type="button"
        class="pagination-btn"
        disabled={currentPage >= totalPages}
        onClick={() => onPageChange(offset + limit)}
      >
        Next &rsaquo;
      </button>
    </nav>
  );
}
