import { useEffect, useState } from "react";
import { api, formatPrice } from "../api";
import ProductForm from "../components/ProductForm";

const LOW_STOCK = 5;

export default function ProductsPage() {
  const [products, setProducts] = useState(null);
  const [editing, setEditing] = useState(null); // null = closed, {} = new, product = edit
  const [error, setError] = useState("");

  const load = () =>
    api("/products")
      .then(setProducts)
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const save = async (values) => {
    if (editing.id) {
      await api(`/products/${editing.id}`, { method: "PUT", body: values });
    } else {
      await api("/products", { method: "POST", body: values });
    }
    setEditing(null);
    await load();
  };

  const remove = async (product) => {
    if (!confirm(`Delete "${product.name}"? Existing orders keep their line items.`)) return;
    setError("");
    try {
      await api(`/products/${product.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!products && !error) return <p className="muted">Loading products…</p>;

  return (
    <>
      <div className="page-head">
        <h1>Products</h1>
        <button onClick={() => setEditing({})}>New product</button>
      </div>

      {editing && (
        <ProductForm
          key={editing.id || "new"}
          product={editing}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        {products?.length === 0 ? (
          <p className="muted">No products yet. Create your first one.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="right">Price</th>
                <th className="right">Stock</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {products?.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div>{p.name}</div>
                    {p.description && <div className="muted small">{p.description}</div>}
                  </td>
                  <td className="right">{formatPrice(p.price)}</td>
                  <td className="right">
                    <span className={p.stock === 0 ? "error" : p.stock <= LOW_STOCK ? "warn" : ""}>
                      {p.stock}
                    </span>
                  </td>
                  <td className="right">
                    <div className="actions">
                      <button className="ghost" onClick={() => setEditing(p)}>
                        Edit
                      </button>
                      <button className="ghost danger" onClick={() => remove(p)}>
                        Delete
                      </button>
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
