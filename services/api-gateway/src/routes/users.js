const express = require("express");
const { userClient } = require("../clients/grpcClients");
const { authenticate } = require("../middleware/auth");
const { sendGrpcError } = require("../utils/grpcError");

const router = express.Router();

router.post("/register", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email and password are required" });
  }
  userClient.Register({ name, email, password }, (err, response) => {
    if (err) return sendGrpcError(res, err);
    res.status(201).json(response);
  });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body;
  userClient.Login({ email, password }, (err, response) => {
    if (err?.code === 5) return res.status(401).json({ error: "Invalid email or password" });
    if (err) return sendGrpcError(res, err);
    res.json(response);
  });
});

router.get("/me", authenticate, (req, res) => {
  userClient.GetUser({ userId: req.user.userId }, (err, response) => {
    if (err) return sendGrpcError(res, err);
    res.json(response);
  });
});

module.exports = router;
