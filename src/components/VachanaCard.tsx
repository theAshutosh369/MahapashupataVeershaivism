import type { Vachana } from "../types";
import HighlightText from "./HighlightText";

interface Props {
    vachana: Vachana;
    search: string;
}

function VachanaCard({ vachana, search }: Props) {
    return (
        <div style={{
            background: "#fff",
            borderRadius: 12,
            padding: "clamp(18px, 3vw, 30px)",
            marginBottom: "clamp(24px, 4vw, 35px)",
            boxShadow: "0 3px 10px rgba(0,0,0,.08)"
        }}>
            <h2 style={{ color: "#7A1F1F", marginBottom: "clamp(12px, 2vw, 20px)", fontSize: "var(--font-h3)" }}>
                {vachana.number}
            </h2>

            <div>
                <h3 style={{ fontSize: "var(--font-body)", marginBottom: 8 }}>Kannada</h3>
                <pre style={{
                    whiteSpace: "pre-wrap",
                    fontFamily: "Noto Sans Kannada",
                    fontSize: "clamp(16px, 2.5vw, 22px)",
                    lineHeight: 1.8,
                    overflowWrap: "anywhere",
                    wordBreak: "break-word"
                }}>
                    <HighlightText text={vachana.kannada} search={search} />
                </pre>
            </div>

            <div style={{ marginTop: "clamp(20px, 3vw, 30px)" }}>
                <h3 style={{ fontSize: "var(--font-body)", marginBottom: 8 }}>Transliteration</h3>
                <pre style={{
                    whiteSpace: "pre-wrap",
                    fontFamily: "Noto Sans Kannada",
                    fontSize: "clamp(16px, 2.5vw, 22px)",
                    lineHeight: 1.8,
                    overflowWrap: "anywhere",
                    wordBreak: "break-word"
                }}>
                    <HighlightText text={vachana.transliteration} search={search} />
                </pre>
            </div>

            <div style={{ marginTop: "clamp(20px, 3vw, 30px)" }}>
                <h3 style={{ fontSize: "var(--font-body)", marginBottom: 8 }}>English</h3>
                <pre style={{
                    whiteSpace: "pre-wrap",
                    fontFamily: "Noto Sans Kannada",
                    fontSize: "clamp(16px, 2.5vw, 22px)",
                    lineHeight: 1.8,
                    overflowWrap: "anywhere",
                    wordBreak: "break-word"
                }}>
                    <HighlightText text={vachana.translation ?? ""} search={search} />
                </pre>
            </div>
        </div>
    );
}

export default VachanaCard;

