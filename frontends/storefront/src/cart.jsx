import { createContext, useContext, useEffect, useState } from "react";

const CART_KEY = "storefront_cart";
const CartContext = createContext(null);

function loadCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || [];
  } catch {
    return [];
  }
}

// Cart lines: { product: { id, name, price, stock }, quantity }
export function CartProvider({ children }) {
  const [lines, setLines] = useState(loadCart);

  useEffect(() => {
    localStorage.setItem(CART_KEY, JSON.stringify(lines));
  }, [lines]);

  const add = (product) =>
    setLines((prev) => {
      const line = prev.find((l) => l.product.id === product.id);
      if (!line) return [...prev, { product, quantity: 1 }];
      return prev.map((l) =>
        l.product.id === product.id
          ? { product, quantity: Math.min(l.quantity + 1, product.stock) }
          : l
      );
    });

  const setQuantity = (id, quantity) =>
    setLines((prev) =>
      quantity <= 0
        ? prev.filter((l) => l.product.id !== id)
        : prev.map((l) => (l.product.id === id ? { ...l, quantity } : l))
    );

  const clear = () => setLines([]);
  const count = lines.reduce((n, l) => n + l.quantity, 0);
  const total = lines.reduce((sum, l) => sum + l.product.price * l.quantity, 0);
  const quantityOf = (id) => lines.find((l) => l.product.id === id)?.quantity || 0;

  return (
    <CartContext.Provider value={{ lines, add, setQuantity, clear, count, total, quantityOf }}>
      {children}
    </CartContext.Provider>
  );
}

export const useCart = () => useContext(CartContext);
