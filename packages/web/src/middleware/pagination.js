// src/middleware/pagination.js
// Parses ?page= and ?per_page= query params and attaches a
// `paginate(query, params)` helper to res.locals for all API routes.

export function paginationMiddleware(req, res, next) {
  const page    = Math.max(1, parseInt(req.query.page    ?? "1",  10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page ?? "25", 10) || 25));
  const offset  = (page - 1) * perPage;

  res.locals.page    = page;
  res.locals.perPage = perPage;
  res.locals.offset  = offset;

  // Convenience: build a paginated response envelope
  res.locals.paginated = (rows, total) => ({
    data: rows,
    meta: {
      page,
      per_page:    perPage,
      total:       Number(total),
      total_pages: Math.ceil(Number(total) / perPage),
    },
  });

  next();
}
