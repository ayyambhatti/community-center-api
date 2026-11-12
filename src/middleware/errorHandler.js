function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status = err.statusCode || err.status || 500;
  if (status >= 500) {
    console.error("[API Error]", err);
  }

  // Handle common MySQL errors gracefully without leaking SQL details
  if (err.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      success: false,
      message: "A record with this unique identifier already exists.",
    });
  }

  res.status(status).json({
    success: false,
    message: status >= 500 ? "Internal server error" : err.message,
  });
}

module.exports = {
  asyncHandler,
  notFoundHandler,
  errorHandler,
};

