const mongoose = require("mongoose");
const Order = require("../models/Order");
const { publish } = require("../rabbitmq/publisher");
const { reserveStock, releaseStock } = require("../clients/productClient");

const INVALID_ARGUMENT = 3;
const NOT_FOUND = 5;
const FAILED_PRECONDITION = 9;
const INTERNAL = 13;
const UNAVAILABLE = 14;

const CANCELLABLE_STATUSES = ["pending", "confirmed"];

function toResponse(order) {
  return {
    orderId: order._id.toString(),
    userId: order.userId,
    items: order.items,
    status: order.status,
    totalAmount: order.totalAmount,
    createdAt: order.createdAt.toISOString(),
  };
}

// Events only drive notifications, so a failed publish is logged rather than failing the request.
function publishEvent(routingKey, payload) {
  publish(routingKey, payload).catch((err) =>
    console.error(`Failed to publish ${routingKey} for order ${payload.orderId}:`, err.message)
  );
}

function stockErrorToGrpc(err) {
  // Pass through business errors from product-service; anything else means it is unreachable.
  if ([INVALID_ARGUMENT, NOT_FOUND, FAILED_PRECONDITION].includes(err.code)) return err;
  return { code: UNAVAILABLE, message: "Product service unavailable" };
}

async function CreateOrder(call, callback) {
  const { userId, items, email } = call.request;

  if (!items.length) return callback({ code: INVALID_ARGUMENT, message: "Order has no items" });
  if (items.some((i) => !Number.isInteger(i.quantity) || i.quantity <= 0)) {
    return callback({ code: INVALID_ARGUMENT, message: "Quantity must be a positive integer" });
  }

  // Reserve stock and get authoritative prices; client-sent prices are ignored.
  let reserved;
  try {
    const stockItems = items.map(({ productId, quantity }) => ({ productId, quantity }));
    reserved = (await reserveStock(stockItems)).items;
  } catch (err) {
    return callback(stockErrorToGrpc(err));
  }

  try {
    const totalAmount = reserved.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const order = await Order.create({
      userId,
      email,
      items: reserved,
      totalAmount,
      status: "pending",
    });

    publishEvent("order.created", {
      orderId: order._id.toString(),
      userId,
      email,
      items: reserved,
      totalAmount,
    });

    callback(null, {
      orderId: order._id.toString(),
      status: order.status,
      totalAmount: order.totalAmount,
    });
  } catch (err) {
    await releaseStock(reserved.map(({ productId, quantity }) => ({ productId, quantity }))).catch(
      (e) => console.error("Failed to release stock after order failure:", e.message, reserved)
    );
    callback({ code: INTERNAL, message: "Failed to create order" });
  }
}

async function GetOrder(call, callback) {
  try {
    const { orderId, userId } = call.request;
    if (!mongoose.isValidObjectId(orderId)) {
      return callback({ code: NOT_FOUND, message: "Order not found" });
    }
    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) return callback({ code: NOT_FOUND, message: "Order not found" });
    callback(null, toResponse(order));
  } catch (err) {
    callback({ code: INTERNAL, message: err.message });
  }
}

async function ListUserOrders(call, callback) {
  try {
    const orders = await Order.find({ userId: call.request.userId });
    callback(null, { orders: orders.map(toResponse) });
  } catch (err) {
    callback({ code: INTERNAL, message: err.message });
  }
}

async function CancelOrder(call, callback) {
  try {
    const { orderId, userId } = call.request;
    if (!mongoose.isValidObjectId(orderId)) {
      return callback({ code: NOT_FOUND, message: "Order not found" });
    }

    // Atomic transition: two concurrent cancels can't both succeed and release stock twice.
    const previous = await Order.findOneAndUpdate(
      { _id: orderId, userId, status: { $in: CANCELLABLE_STATUSES } },
      { status: "cancelled" }
    );

    if (!previous) {
      const order = await Order.findOne({ _id: orderId, userId });
      if (!order) return callback({ code: NOT_FOUND, message: "Order not found" });
      const message =
        order.status === "cancelled" ? "Order already cancelled" : "Cannot cancel order in current status";
      return callback({ code: FAILED_PRECONDITION, message });
    }

    const stockItems = previous.items.map(({ productId, quantity }) => ({ productId, quantity }));
    try {
      await releaseStock(stockItems);
    } catch (err) {
      // Put the order back so the user can retry instead of losing the stock.
      await Order.updateOne({ _id: orderId, status: "cancelled" }, { status: previous.status });
      return callback(stockErrorToGrpc(err));
    }

    publishEvent("order.cancelled", {
      orderId,
      userId,
      email: previous.email,
      items: stockItems,
    });

    callback(null, { success: true, message: "Order cancelled successfully" });
  } catch (err) {
    callback({ code: INTERNAL, message: err.message });
  }
}

async function UpdateOrderStatus(call, callback) {
  try {
    const { orderId, status } = call.request;
    if (!mongoose.isValidObjectId(orderId)) {
      return callback({ code: NOT_FOUND, message: "Order not found" });
    }
    const order = await Order.findByIdAndUpdate(orderId, { status }, { new: true, runValidators: true });
    if (!order) return callback({ code: NOT_FOUND, message: "Order not found" });

    if (status === "shipped") {
      publishEvent("order.shipped", {
        orderId: order._id.toString(),
        userId: order.userId,
        email: order.email,
        items: order.items,
      });
    }

    callback(null, { success: true, status: order.status });
  } catch (err) {
    callback({ code: INTERNAL, message: err.message });
  }
}

module.exports = { CreateOrder, GetOrder, ListUserOrders, CancelOrder, UpdateOrderStatus };
