// Map gRPC status codes to HTTP and send a clean error message.
const HTTP_STATUS = {
  3: 400, // INVALID_ARGUMENT
  5: 404, // NOT_FOUND
  6: 409, // ALREADY_EXISTS
  7: 403, // PERMISSION_DENIED
  9: 409, // FAILED_PRECONDITION
  14: 503, // UNAVAILABLE
  16: 401, // UNAUTHENTICATED
};

function sendGrpcError(res, err) {
  const status = HTTP_STATUS[err.code] || 500;
  res.status(status).json({ error: status === 500 ? "Internal error" : err.details || err.message });
}

module.exports = { sendGrpcError };
