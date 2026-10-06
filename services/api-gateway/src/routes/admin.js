const express = require("express");
const { orderClient } = require("../clients/grpcClients");
const { authenticate, requireRole } = require("../middleware/auth");
const { sendGrpcError } = require("../utils/grpcError");

const router = express.Router();
router.use(authenticate, requireRole("admin"));

router.get("/orders", (req, res) => {
  orderClient.ListAllOrders({ status: req.query.status || "" }, (err, response) => {
    if (err) return sendGrpcError(res, err);
    res.json(response.orders);
  });
});

router.patch("/orders/:id/status", (req, res) => {
  const { status } = req.body;
  if (typeof status !== "string") return res.status(400).json({ error: "status is required" });
  orderClient.UpdateOrderStatus({ orderId: req.params.id, status }, (err, response) => {
    if (err) return sendGrpcError(res, err);
    res.json(response);
  });
});

module.exports = router;
