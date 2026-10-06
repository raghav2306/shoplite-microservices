const express = require("express");
const { productClient } = require("../clients/grpcClients");
const { authenticate, requireRole } = require("../middleware/auth");

const router = express.Router();

router.get("/", (req, res) => {
  productClient.ListProducts({}, (err, response) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(response.products);
  });
});

router.get("/:id", (req, res) => {
  productClient.GetProduct({ productId: req.params.id }, (err, response) => {
    if (err) return res.status(404).json({ error: err.message });
    res.json(response);
  });
});

router.post("/", authenticate, requireRole("admin"), (req, res) => {
  const { name, description, price, stock } = req.body;
  productClient.CreateProduct({ name, description, price, stock }, (err, response) => {
    if (err) return res.status(400).json({ error: err.message });
    res.status(201).json(response);
  });
});

module.exports = router;
