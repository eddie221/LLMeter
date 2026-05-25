export function paginateRows<T>(items: T[], page: number, pageSize: string) {
  const size = Number(pageSize) || 25;
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * size;
  return { rows: items.slice(start, start + size), page: safePage, totalPages };
}
