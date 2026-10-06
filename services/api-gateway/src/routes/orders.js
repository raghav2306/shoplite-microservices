const express = require("express");
const { orderClient } = require("../clients/grpcClients");
const { authenticate } = require("../middleware/auth");
const { sendGrpcError } = require("../utils/grpcError");

const router = express.Router();

router.post("/", authenticate, (req, res) => {
  const { items } = req.body;

  const valid =
    Array.isArray(items) &&
    items.length > 0 &&
    items.every(
      (i) => typeof i?.productId === "string" && Number.isInteger(i.quantity) && i.quantity > 0
    );
  if (!valid) {
    return res
      .status(400)
      .json({ error: "items must be a non-empty array of { productId, quantity > 0 }" });
  }

  // Only productId and quantity are forwarded; price comes from product-service.
  // Stock is reserved atomically by order-service.
  orderClient.CreateOrder(
    {
      userId: req.user.userId,
      email: req.user.email,
      items: items.map(({ productId, quantity }) => ({ productId, quantity })),
    },
    (err, response) => {
      if (err) return sendGrpcError(res, err);
      res.status(201).json(response);
    }
  );
});

router.get("/", authenticate, (req, res) => {
  orderClient.ListUserOrders({ userId: req.user.userId }, (err, response) => {
    if (err) return sendGrpcError(res, err);
    res.json(response.orders);
  });
});

router.get("/:id", authenticate, (req, res) => {
  orderClient.GetOrder({ orderId: req.params.id, userId: req.user.userId }, (err, response) => {
    if (err) return sendGrpcError(res, err);
    res.json(response);
  });
});

router.delete("/:id", authenticate, (req, res) => {
  orderClient.CancelOrder(
    { orderId: req.params.id, userId: req.user.userId },
    (err, response) => {
      if (err) return sendGrpcError(res, err);
      res.json(response);
    }
  );
});

module.exports = router;
