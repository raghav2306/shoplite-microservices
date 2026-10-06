import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, formatPrice } from "../api";
import StatusBadge from "../components/StatusBadge";

const CANCELLABLE = ["pending", "confirmed"];

export default function OrdersPage() {
  const location = useLocation();
  const [orders, setOrders] = useState(null);
  const [productNames, setProductNames] = useState({});
  const [error, setError] = useState("");

  const load = () =>
    Promise.all([api("/orders"), api("/products")])
      .then(([orders, products]) => {
        setOrders(orders);
        setProductNames(Object.fromEntries(products.map((p) => [p.id, p.name])));
      })
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const cancel = async (orderId) => {
    if (!confirm("Cancel this order?")) return;
    try {
      await api(`/orders/${orderId}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!orders && !error) return <p className="muted">Loading orders…</p>;

  return (
    <>
      <h1>My orders</h1>
      {location.state?.placed && <p className="success">Thanks! Your order has been placed.</p>}
      {error && <p className="error">{error}</p>}
      {orders?.length === 0 && (
        <p className="muted">
          No orders yet. <Link to="/">Start shopping</Link>
        </p>
      )}
      <div className="orders">
        {orders?.map((o) => (
          <article key={o.orderId} className="card order">
            <div className="order-head">
              <div>
                <div className="muted small">Order #{o.orderId.slice(-8)}</div>
                <div className="small">{new Date(o.createdAt).toLocaleString()}</div>
              </div>
              <StatusBadge status={o.status} />
            </div>
            <ul className="order-items">
              {o.items.map((item, i) => (
                <li key={i}>
                  <span>
                    {productNames[item.productId] || "Removed product"} × {item.quantity}
                  </span>
                  <span>{formatPrice(item.price * item.quantity)}</span>
                </li>
              ))}
            </ul>
            <div className="order-foot">
              <strong>{formatPrice(o.totalAmount)}</strong>
              {CANCELLABLE.includes(o.status) && (
                <button className="danger ghost" onClick={() => cancel(o.orderId)}>
                  Cancel order
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
