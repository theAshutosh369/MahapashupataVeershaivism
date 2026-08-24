function Footer() {
    return (
        <footer style={{
            marginTop: "clamp(40px, 8vw, 80px)",
            padding: "clamp(24px, 4vw, 40px) clamp(18px, 3vw, 25px)",
            background: "#7A1F1F",
            color: "rgba(255,255,255,0.9)",
            fontSize: "var(--font-body)",
        }}>
            <div style={{
                maxWidth: 1200,
                margin: "0 auto",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: "clamp(20px, 4vw, 40px)",
                textAlign: "left",
            }}>
                {/* Brand */}
                <div>
                    <h3 style={{
                        fontSize: "clamp(18px, 2.5vw, 22px)",
                        fontWeight: 700,
                        color: "#fff",
                        marginBottom: 10,
                    }}>
                        Mahapashupata Veershaivam
                    </h3>
                    <p style={{ fontSize: "14px", lineHeight: 1.6, color: "rgba(255,255,255,0.7)" }}>
                        A Digital Library of Kannada Vachanas — preserving and sharing the spiritual poetry of the Sharanas.
                    </p>
                </div>

                {/* Social Links */}
                <div>
                    <h4 style={{
                        fontSize: "15px",
                        fontWeight: 600,
                        color: "#fff",
                        marginBottom: 12,
                        textTransform: "uppercase",
                        letterSpacing: "1px",
                    }}>
                        Connect
                    </h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <a href="https://www.instagram.com/shivshivaatmaj/" target="_blank" rel="noopener noreferrer"
                            style={{ color: "rgba(255,255,255,0.8)", textDecoration: "none", display: "flex", alignItems: "center", gap: 8, fontSize: "14px" }}>
                            <span style={{ fontSize: "16px" }}>📷</span> Instagram (@shivshivaatmaj)
                        </a>
                        <a href="https://pinterest.com/veershaivism/" target="_blank" rel="noopener noreferrer"
                            style={{ color: "rgba(255,255,255,0.8)", textDecoration: "none", display: "flex", alignItems: "center", gap: 8, fontSize: "14px" }}>
                            <span style={{ fontSize: "16px" }}>📌</span> Pinterest (@veershaivism)
                        </a>
                    </div>
                </div>

                {/* Contact */}
                <div>
                    <h4 style={{
                        fontSize: "15px",
                        fontWeight: 600,
                        color: "#fff",
                        marginBottom: 12,
                        textTransform: "uppercase",
                        letterSpacing: "1px",
                    }}>
                        Contact
                    </h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: "14px", color: "rgba(255,255,255,0.8)" }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: "16px" }}>📧</span> shivshivaatmaj@outlook.com
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: "16px" }}>📞</span> +91 97436 67373
                        </span>
                    </div>
                </div>
            </div>

            {/* Divider */}
            <div style={{
                maxWidth: 1200,
                margin: "24px auto 16px",
                borderTop: "1px solid rgba(255,255,255,0.15)",
            }} />

            {/* Copyright */}
            <p style={{
                textAlign: "center",
                fontSize: "13px",
                color: "rgba(255,255,255,0.5)",
                maxWidth: 1200,
                margin: "0 auto",
            }}>
                &copy; {new Date().getFullYear()} Vachana Sanchaya. All rights reserved.
            </p>
        </footer>
    );
}

export default Footer;

