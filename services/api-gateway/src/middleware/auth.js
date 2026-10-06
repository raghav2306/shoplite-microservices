const { userClient } = require("../clients/grpcClients");

function authenticate(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  const token = authHeader.split(" ")[1];

  userClient.ValidateToken({ token }, (err, response) => {
    if (err || !response.valid) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.user = { userId: response.userId, email: response.email, role: response.role };
    next();
  });
}

// Use after authenticate
function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

module.exports = { authenticate, requireRole };
