import { NavLink } from "react-router-dom";
import { useAuth } from "../auth";

export default function Header() {
  const { user, logout } = useAuth();

  return (
    <header className="header">
      <div className="container header-inner">
        <span className="brand">
          ShopLite <span className="admin-tag">Admin</span>
        </span>
        <nav className="nav">
          <NavLink to="/orders">Orders</NavLink>
          <NavLink to="/products">Products</NavLink>
          <span className="muted user-name">{user.email}</span>
          <button className="link-button" onClick={logout}>
            Log out
          </button>
        </nav>
      </div>
    </header>
  );
}
