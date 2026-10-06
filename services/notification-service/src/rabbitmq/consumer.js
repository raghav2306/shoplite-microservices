const amqp = require("amqplib");
const {
  sendOrderConfirmation,
  sendOrderCancellation,
  sendOrderShipped,
} = require("../handlers/emailHandler");

const EXCHANGE = "order_events";
const QUEUE = "notification_service_queue";
const DEAD_LETTER_QUEUE = `${QUEUE}.dlq`;
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30_000;

const handlers = {
  "order.created": sendOrderConfirmation,
  "order.cancelled": sendOrderCancellation,
  "order.shipped": sendOrderShipped,
};

let connection = null;
let channel = null;
let closing = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isConnected = () => channel !== null;

async function handleMessage(ch, msg) {
  if (!msg) return; // consumer cancelled by broker; the close handler reconnects
  // Retried messages are sent straight to QUEUE, so the original key travels in a header.
  const routingKey = msg.properties.headers?.["x-routing-key"] || msg.fields.routingKey;
  const retries = msg.properties.headers?.["x-retries"] || 0;

  try {
    const event = JSON.parse(msg.content.toString());
    await handlers[routingKey]?.(event);
    ch.ack(msg);
  } catch (err) {
    const permanent = err instanceof SyntaxError || retries >= MAX_RETRIES;
    console.error(
      `Failed to process ${routingKey} (attempt ${retries + 1}):`,
      err.message,
      permanent ? "-> dead-letter queue" : "-> retrying"
    );
    // Re-publish with a retry counter instead of nack-requeue, so a bad message
    // can't loop forever; after MAX_RETRIES it is parked in the DLQ for inspection.
    const target = permanent ? DEAD_LETTER_QUEUE : QUEUE;
    ch.sendToQueue(target, msg.content, {
      persistent: true,
      contentType: msg.properties.contentType,
      headers: {
        ...msg.properties.headers,
        "x-retries": retries + 1,
        "x-routing-key": routingKey,
        "x-last-error": err.message,
      },
    });
    ch.ack(msg);
  }
}

async function setup() {
  const conn = await amqp.connect(process.env.RABBITMQ_URL || "amqp://localhost");
  try {
    const ch = await conn.createChannel();
    await ch.prefetch(10);

    await ch.assertExchange(EXCHANGE, "topic", { durable: true });
    await ch.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
    const q = await ch.assertQueue(QUEUE, { durable: true });
    for (const key of Object.keys(handlers)) {
      await ch.bindQueue(q.queue, EXCHANGE, key);
    }

    await ch.consume(q.queue, (msg) =>
      handleMessage(ch, msg).catch((err) => console.error("Unhandled consumer error:", err.message))
    );

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
    startConsumer();
  });
  console.log("Notification Service listening for order events...");
}

// Retries until connected; reconnects automatically if the connection drops later.
async function startConsumer() {
  for (let attempt = 0; !closing; attempt++) {
    try {
      await setup();
      return;
    } catch (err) {
      const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
      console.error(`RabbitMQ connect failed (${err.message}), retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

async function stopConsumer() {
  closing = true;
  if (connection) await connection.close();
}

module.exports = { startConsumer, stopConsumer, isConnected };
