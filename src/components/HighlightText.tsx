interface Props {

    text: string;

    search: string;

}

function escapeRegExp(text: string) {

    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

}

function HighlightText({ text, search }: Props) {

    const query = search.trim();

    if (!query) {

        return <>{text}</>;

    }

    const regex = new RegExp(
        `(${escapeRegExp(query)})`,
        "gi"
    );

    const parts = text.split(regex);

    return (

        <>

            {

                parts.map((part, index) => {

                    const isMatch = part.toLowerCase() === query.toLowerCase();

                    return isMatch

                        ? (

                            <mark
                                key={index}
                                style={{
                                    background: "#fff176",
                                    padding: "1px 2px"
                                }}
                            >
                                {part}
                            </mark>

                        )

                        : (

                            <span key={index}>
                                {part}
                            </span>

                        );

                })

            }

        </>

    );

}

export default HighlightText;
