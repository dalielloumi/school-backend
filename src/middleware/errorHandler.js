/**
 * Global error handler middleware
 */
function errorHandler(err, req, res, next) {
  // Log error details in development
  if (process.env.NODE_ENV !== 'production') {
    console.error('[ErrorHandler]', err);
  } else {
    console.error('[ErrorHandler]', err.message);
  }

  // PostgreSQL errors
  if (err.code) {
    switch (err.code) {
      case '23505': // unique_violation
        return res.status(409).json({
          success: false,
          message: 'A record with this value already exists',
          detail: err.detail || null,
        });
      case '23503': // foreign_key_violation
        return res.status(400).json({
          success: false,
          message: 'Referenced record does not exist',
          detail: err.detail || null,
        });
      case '23502': // not_null_violation
        return res.status(400).json({
          success: false,
          message: `Field "${err.column}" is required`,
        });
      case '22P02': // invalid_text_representation
        return res.status(400).json({
          success: false,
          message: 'Invalid data format',
        });
      default:
        break;
    }
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token expired' });
  }

  // Custom app errors with statusCode
  if (err.statusCode) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message || 'An error occurred',
    });
  }

  // Default 500
  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
}

/**
 * Create an AppError with a status code
 */
function createError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = errorHandler;
module.exports.createError = createError;
