import { useEffect, useState } from "react";
import { api, formatPrice } from "../api";
import StatusBadge from "../components/StatusBadge";

const STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"];

// Mirrors the transitions order-service allows
const ACTIONS = {
  pending: [
    { status: "confirmed", label: "Confirm" },
    { status: "cancelled", label: "Cancel", danger: true },
  ],
  confirmed: [
    { status: "shipped", label: "Mark shipped" },
    { status: "cancelled", label: "Cancel", danger: true },
  ],
  shipped: [{ status: "delivered", label: "Mark delivered" }],
};

export default function OrdersPage() {
  const [orders, setOrders] = useState(null);
  const [products, setProducts] = useState({});
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = () =>
    Promise.all([api("/admin/orders"), api("/products")])
      .then(([orders, products]) => {
        setOrders(orders);
        setProducts(Object.fromEntries(products.map((p) => [p.id, p.name])));
      })
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const updateStatus = async (order, status) => {
    if (status === "cancelled" && !confirm("Cancel this order and return its stock?")) return;
    setError("");
    setBusyId(order.orderId);
    try {
      await api(`/admin/orders/${order.orderId}/status`, { method: "PATCH", body: { status } });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (!orders && !error) return <p className="muted">Loading orders…</p>;

  const counts = Object.fromEntries(
    STATUSES.map((s) => [s, orders?.filter((o) => o.status === s).length || 0])
  );
  const revenue = (orders || [])
    .filter((o) => o.status !== "cancelled")
    .reduce((sum, o) => sum + o.totalAmount, 0);
  const visible = filter ? orders.filter((o) => o.status === filter) : orders || [];

  return (
    <>
      <h1>Orders</h1>

      <div className="stats">
        <div className="card stat">
          <div className="stat-label">Revenue (excl. cancelled)</div>
          <div className="stat-value">{formatPrice(revenue)}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Awaiting confirmation</div>
          <div className="stat-value">{counts.pending}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">To ship</div>
          <div className="stat-value">{counts.confirmed}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Total orders</div>
          <div className="stat-value">{orders?.length || 0}</div>
        </div>
      </div>

      <div className="tabs">
        <button className={filter === "" ? "tab active" : "tab"} onClick={() => setFilter("")}>
          All
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            className={filter === s ? "tab active" : "tab"}
            onClick={() => setFilter(s)}
          >
            {s} <span className="muted">{counts[s]}</span>
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        {visible.length === 0 ? (
          <p className="muted">No orders.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Items</th>
                <th className="right">Total</th>
                <th>Status</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => (
                <tr key={o.orderId}>
                  <td>
                    <div className="mono">#{o.orderId.slice(-8)}</div>
                    <div className="muted small">{new Date(o.createdAt).toLocaleString()}</div>
                  </td>
                  <td>{o.email || <span className="muted">—</span>}</td>
                  <td className="small">
                    {o.items.map((item, i) => (
                      <div key={i}>
                        {products[item.productId] || "Removed product"} × {item.quantity}
                      </div>
                    ))}
                  </td>
                  <td className="right">{formatPrice(o.totalAmount)}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="right">
                    <div className="actions">
                      {(ACTIONS[o.status] || []).map((a) => (
                        <button
                          key={a.status}
                          className={a.danger ? "ghost danger" : "ghost"}
                          disabled={busyId === o.orderId}
                          onClick={() => updateStatus(o, a.status)}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
