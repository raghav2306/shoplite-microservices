import { useEffect, useState } from "react";
import { api, formatPrice } from "../api";
import { useCart } from "../cart";

export default function ProductsPage() {
  const [products, setProducts] = useState(null);
  const [error, setError] = useState("");
  const { add, quantityOf } = useCart();

  useEffect(() => {
    api("/products")
      .then(setProducts)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!products) return <p className="muted">Loading products…</p>;
  if (!products.length) return <p className="muted">No products yet. Check back soon.</p>;

  return (
    <>
      <h1>Products</h1>
      <div className="grid">
        {products.map((p) => {
          const inCart = quantityOf(p.id);
          const soldOut = p.stock === 0;
          const maxed = inCart >= p.stock;
          return (
            <article key={p.id} className="card product">
              <h2>{p.name}</h2>
              {p.description && <p className="muted">{p.description}</p>}
              <div className="product-footer">
                <div>
                  <div className="price">{formatPrice(p.price)}</div>
                  <div className={soldOut ? "stock out" : "stock"}>
                    {soldOut ? "Sold out" : `${p.stock} in stock`}
                  </div>
                </div>
                <button onClick={() => add(p)} disabled={soldOut || maxed}>
                  {inCart ? `In cart (${inCart})` : "Add to cart"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
