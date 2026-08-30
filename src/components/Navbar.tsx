import { Link } from "react-router-dom";
import { useState } from "react";

import "../styles/components/navbar.css";

function Navbar() {
    const [menuOpen, setMenuOpen] = useState(false);

    function closeMenu() {
        setMenuOpen(false);
    }

    return (
        <header className="navbar">
            <div className="container navbar-inner">
                <h2 className="navbar-brand">Mahapashupata Veershaivam</h2>

                <button
                    className="navbar-toggle"
                    onClick={() => setMenuOpen((prev) => !prev)}
                    aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
                    aria-expanded={menuOpen}
                >
                    {menuOpen ? "✕" : "☰"}
                </button>

                <nav className={`navbar-links${menuOpen ? " open" : ""}`}>
                    <Link to="/" onClick={closeMenu}>Home</Link>
                    <Link to="/global-search" onClick={closeMenu}>Global Search</Link>
                    <Link to="/about" onClick={closeMenu}>About</Link>
                    <Link to="/settings" onClick={closeMenu}>Settings</Link>
                    <Link to="/granthas" onClick={closeMenu}>Granthas</Link>
                    <Link to="/agent" onClick={closeMenu}>AI Agent</Link>
                </nav>
            </div>
        </header>
    );
}

export default Navbar;
