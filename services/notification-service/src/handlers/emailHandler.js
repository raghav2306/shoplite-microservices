const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.mailtrap.io",
  port: parseInt(process.env.SMTP_PORT) || 587,
  // Local SMTP sinks (e.g. Mailpit) don't use auth
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
});

async function sendOrderConfirmation(event) {
  console.log(`[Notification] Order created: ${event.orderId} for user ${event.userId}`);
  // In production, look up user email via gRPC or embed it in the event payload
  await transporter.sendMail({
    from: process.env.FROM_EMAIL || "noreply@ecommerce.com",
    to: event.email || "customer@example.com",
    subject: `Order Confirmed - #${event.orderId}`,
    html: `<h2>Your order has been placed!</h2>
           <p>Order ID: <strong>${event.orderId}</strong></p>
           <p>Total: <strong>$${event.totalAmount?.toFixed(2)}</strong></p>`,
  });
}

async function sendOrderCancellation(event) {
  console.log(`[Notification] Order cancelled: ${event.orderId}`);
  await transporter.sendMail({
    from: process.env.FROM_EMAIL || "noreply@ecommerce.com",
    to: event.email || "customer@example.com",
    subject: `Order Cancelled - #${event.orderId}`,
    html: `<h2>Your order has been cancelled.</h2>
           <p>Order ID: <strong>${event.orderId}</strong></p>`,
  });
}

async function sendOrderShipped(event) {
  console.log(`[Notification] Order shipped: ${event.orderId}`);
  await transporter.sendMail({
    from: process.env.FROM_EMAIL || "noreply@ecommerce.com",
    to: event.email || "customer@example.com",
    subject: `Your Order Has Shipped - #${event.orderId}`,
    html: `<h2>Your order is on the way!</h2>
           <p>Order ID: <strong>${event.orderId}</strong></p>`,
  });
}

module.exports = { sendOrderConfirmation, sendOrderCancellation, sendOrderShipped };
