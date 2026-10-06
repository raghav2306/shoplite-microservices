import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, formatPrice } from "../api";
import { useAuth } from "../auth";
import { useCart } from "../cart";

export default function CartPage() {
  const { lines, setQuantity, clear, total } = useCart();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [placing, setPlacing] = useState(false);

  const checkout = async () => {
    if (!user) return navigate("/login?next=/cart");
    setError("");
    setPlacing(true);
    try {
      await api("/orders", {
        method: "POST",
        body: { items: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })) },
      });
      clear();
      navigate("/orders", { state: { placed: true } });
    } catch (err) {
      setError(err.message);
    } finally {
      setPlacing(false);
    }
  };

  if (!lines.length) {
    return (
      <div className="empty">
        <h1>Your cart is empty</h1>
        <Link to="/">Browse products</Link>
      </div>
    );
  }

  return (
    <>
      <h1>Cart</h1>
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Price</th>
                <th>Quantity</th>
                <th className="right">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ product, quantity }) => (
                <tr key={product.id}>
                  <td>{product.name}</td>
                  <td>{formatPrice(product.price)}</td>
                  <td>
                    <div className="qty">
                      <button className="ghost" onClick={() => setQuantity(product.id, quantity - 1)}>
                        −
                      </button>
                      <span>{quantity}</span>
                      <button
                        className="ghost"
                        onClick={() => setQuantity(product.id, quantity + 1)}
                        disabled={quantity >= product.stock}
                      >
                        +
                      </button>
                    </div>
                  </td>
                  <td className="right">{formatPrice(product.price * quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="cart-footer">
          <button className="link-button" onClick={clear}>
            Clear cart
          </button>
          <div className="cart-total">
            <span>
              Total <strong>{formatPrice(total)}</strong>
            </span>
            <button onClick={checkout} disabled={placing}>
              {placing ? "Placing order…" : user ? "Place order" : "Log in to checkout"}
            </button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <p className="muted small">Final prices are confirmed when your order is placed.</p>
      </div>
    </>
  );
}
