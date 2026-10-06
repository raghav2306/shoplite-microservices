const express = require("express");
const { productClient } = require("../clients/grpcClients");
const { authenticate, requireRole } = require("../middleware/auth");
const { sendGrpcError } = require("../utils/grpcError");

const router = express.Router();
const adminOnly = [authenticate, requireRole("admin")];

router.get("/", (req, res) => {
  productClient.ListProducts({}, (err, response) => {
    if (err) return sendGrpcError(res, err);
    res.json(response.products);
  });
});

router.get("/:id", (req, res) => {
  productClient.GetProduct({ productId: req.params.id }, (err, response) => {
    if (err) return sendGrpcError(res, err);
    res.json(response);
  });
});

router.post("/", adminOnly, (req, res) => {
  const { name, description, price, stock } = req.body;
  productClient.CreateProduct({ name, description, price, stock }, (err, response) => {
    if (err) return sendGrpcError(res, err);
    res.status(201).json(response);
  });
});

router.put("/:id", adminOnly, (req, res) => {
  const { name, description, price, stock } = req.body;
  productClient.UpdateProduct(
    { productId: req.params.id, name, description, price, stock },
    (err, response) => {
      if (err) return sendGrpcError(res, err);
      res.json(response);
    }
  );
});

router.delete("/:id", adminOnly, (req, res) => {
  productClient.DeleteProduct({ productId: req.params.id }, (err) => {
    if (err) return sendGrpcError(res, err);
    res.status(204).end();
  });
});

module.exports = router;
