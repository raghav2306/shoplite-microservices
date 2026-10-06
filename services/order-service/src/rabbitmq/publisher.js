const amqp = require("amqplib");

const EXCHANGE = "order_events";
const MAX_BACKOFF_MS = 30_000;

let connection = null;
let channel = null;
let closing = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries until connected; reconnects automatically if the connection drops later.
async function connect() {
  for (let attempt = 0; !closing; attempt++) {
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL || "amqp://localhost");
      try {
        const ch = await conn.createConfirmChannel();
        await ch.assertExchange(EXCHANGE, "topic", { durable: true });
        connection = conn;
        channel = ch;
      } catch (err) {
        await conn.close().catch(() => {});
        throw err;
      }

      conn.on("error", (err) => console.error("RabbitMQ connection error:", err.message));
      conn.on("close", () => {
        channel = null;
        connection = null;
        if (closing) return;
        console.warn("RabbitMQ connection closed, reconnecting...");
        connect();
      });

      console.log("Order Service connected to RabbitMQ");
      return;
    } catch (err) {
      const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
      console.error(`RabbitMQ connect failed (${err.message}), retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

// Resolves once the broker has confirmed the message.
function publish(routingKey, payload) {
  if (!channel) return Promise.reject(new Error("RabbitMQ channel not available"));
  return new Promise((resolve, reject) => {
    channel.publish(
      EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: "application/json" },
      (err) => (err ? reject(err) : resolve())
    );
  }).then(() => console.log(`Published event: ${routingKey}`, payload));
}

async function close() {
  closing = true;
  if (connection) await connection.close();
}

module.exports = { connect, publish, close };
