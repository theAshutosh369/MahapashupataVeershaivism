import type { Vachana } from "../types";
import HighlightText from "./HighlightText";

interface Props {

    vachana: Vachana;

    search: string;

}

function VachanaCard({ vachana, search }: Props) {

    return (

        <div
            style={{

                background: "#fff",

                borderRadius: 12,

                padding: 30,

                marginBottom: 35,

                boxShadow: "0 3px 10px rgba(0,0,0,.08)"

            }}
        >

            <h2
                style={{

                    color: "#7A1F1F",

                    marginBottom: 20

                }}
            >
                {vachana.number}
            </h2>

            <div>

                <h3>Kannada</h3>

                <pre
                    style={{
                        whiteSpace: "pre-wrap",
                        fontFamily: "Noto Sans Kannada",
                        fontSize: 22,
                        lineHeight: 1.8
                    }}
                >

                    <HighlightText

                        text={vachana.kannada}

                        search={search}

                    />

                </pre>

            </div>

            <div
                style={{

                    marginTop: 30

                }}
            >

                <h3>Transliteration</h3>

                <pre
                    style={{
                        whiteSpace: "pre-wrap",
                        fontFamily: "Noto Sans Kannada",
                        fontSize: 22,
                        lineHeight: 1.8
                    }}
                >

                    <HighlightText

                        text={vachana.transliteration}

                        search={search}

                    />

                </pre>

            </div>

            <div
                style={{

                    marginTop: 30

                }}
            >

                <h3>English</h3>

                <pre
                    style={{
                        whiteSpace: "pre-wrap",
                        fontFamily: "Noto Sans Kannada",
                        fontSize: 22,
                        lineHeight: 1.8
                    }}
                >

                    <HighlightText

                        text={vachana.translation ?? ""}

                        search={search}

                    />

                </pre>

            </div>

        </div>

    );

}

export default VachanaCard;