import { Navigate, Route, Routes } from "react-router-dom";
import Header from "./components/Header";
import LoginPage from "./pages/LoginPage";
import OrdersPage from "./pages/OrdersPage";
import ProductsPage from "./pages/ProductsPage";
import { useAuth } from "./auth";

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <p className="muted container">Loading…</p>;
  if (!user) return <LoginPage />;

  return (
    <>
      <Header />
      <main className="container">
        <Routes>
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="*" element={<Navigate to="/orders" replace />} />
        </Routes>
      </main>
    </>
  );
}
