import { useState } from "react";

export default function ProductForm({ product, onSave, onCancel }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError("");
    setBusy(true);
    try {
      await onSave({
        name: form.get("name").trim(),
        description: form.get("description").trim(),
        price: Number(form.get("price")),
        stock: Number(form.get("stock")),
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="card product-form" onSubmit={submit}>
      <h2>{product.id ? `Edit ${product.name}` : "New product"}</h2>
      <div className="form-grid">
        <label className="span-2">
          Name
          <input name="name" defaultValue={product.name} required />
        </label>
        <label className="span-2">
          Description
          <textarea name="description" rows={2} defaultValue={product.description} />
        </label>
        <label>
          Price (USD)
          <input
            name="price"
            type="number"
            min="0"
            step="0.01"
            defaultValue={product.price ?? ""}
            required
          />
        </label>
        <label>
          Stock
          <input name="stock" type="number" min="0" step="1" defaultValue={product.stock ?? 0} required />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button disabled={busy}>{busy ? "Saving…" : "Save product"}</button>
      </div>
    </form>
  );
}
