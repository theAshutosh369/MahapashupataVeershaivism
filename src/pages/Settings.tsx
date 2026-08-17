import { useEffect, useState } from "react";


import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

type Theme = "light" | "dark";

function readThemeFromStorage(): Theme {
    const raw = localStorage.getItem("theme");
    if (raw === "dark" || raw === "light") return raw;
    return "light";
}

function Settings() {
    const [theme] = useState<Theme>(() => {

        if (typeof window === "undefined") return "light";
        return readThemeFromStorage();
    });

    useEffect(() => {
        localStorage.setItem("theme", theme);
        document.documentElement.setAttribute("data-theme", theme);
    }, [theme]);



    return (
        <>
            <Navbar />
            <main className="container" style={{ paddingTop: 45, width: "min(1200px,95%)" }}>
                <h1 style={{ color: "#7A1F1F", fontSize: 34, marginBottom: 18 }}>Settings</h1>

                <section style={{ background: "#fff", borderRadius: 10, padding: 18, boxShadow: "0 2px 10px rgba(0,0,0,.08)" }}>
                    <h2 style={{ color: "#7A1F1F", fontSize: 20, marginBottom: 12 }}>Theme</h2>

                    <p style={{ color: "#333", marginTop: 6 }}>
                        Theme switching is currently disabled.
                    </p>
                </section>
            </main>
            <Footer />
        </>
    );

}

export default Settings;

