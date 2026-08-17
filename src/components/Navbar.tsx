import { Link } from "react-router-dom";

function Navbar() {

    return (

        <header
            style={{
                background: "#7A1F1F",
                color: "white",
                padding: "18px 0"
            }}
        >

            <div
                className="container"
                style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center"
                }}
            >

                <h2>

                    Vachana Sanchaya

                </h2>

                <nav
                    style={{
                        display: "flex",
                        gap: 22,
                        alignItems: "center"
                    }}
                >

                    <Link to="/">
                        Home
                    </Link>

                    <Link to="/global-search">
                        Global Search
                    </Link>

                    <Link to="/about">
                        About
                    </Link>

                    <Link to="/settings">
                        Settings
                    </Link>

                    <Link to="/dataset">
                        Dataset Builder
                    </Link>

                    <Link to="/agent">
                        AI Agent
                    </Link>



                </nav>

            </div>

        </header>

    );

}

export default Navbar;
