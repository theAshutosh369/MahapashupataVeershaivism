import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

function About() {
    return (
        <>
            <Navbar />
            <main className="container" style={{ paddingTop: 45 }}>
                <h1 style={{ color: "#7A1F1F", fontSize: "var(--font-h1)", marginBottom: 18 }}>About</h1>
                <section style={{ background: "#fff", borderRadius: 10, padding: "clamp(18px, 3vw, 24px)", boxShadow: "0 2px 10px rgba(0,0,0,.08)" }}>
                    <p style={{ fontSize: "var(--font-body)", lineHeight: 1.7, color: "#333" }}>
                        Vachana Sanchaya is a digital library dedicated to preserving and sharing Kannada Vachanas —
                        a form of devotional poetry from the Veerashaiva tradition of Karnataka, India.
                    </p>
                </section>
            </main>
            <Footer />
        </>
    );
}

export default About;

