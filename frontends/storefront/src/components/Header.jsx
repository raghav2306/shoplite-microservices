import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../auth";
import { useCart } from "../cart";

export default function Header() {
  const { user, logout } = useAuth();
  const { count } = useCart();

  return (
    <header className="header">
      <div className="container header-inner">
        <Link to="/" className="brand">
          ShopLite
        </Link>
        <nav className="nav">
          <NavLink to="/" end>
            Shop
          </NavLink>
          {user && <NavLink to="/orders">My orders</NavLink>}
          <NavLink to="/cart" className="cart-link">
            Cart{count > 0 && <span className="badge">{count}</span>}
          </NavLink>
          {user ? (
            <>
              <span className="muted user-name">Hi, {user.name}</span>
              <button className="link-button" onClick={logout}>
                Log out
              </button>
            </>
          ) : (
            <NavLink to="/login">Log in</NavLink>
          )}
        </nav>
      </div>
    </header>
  );
}
