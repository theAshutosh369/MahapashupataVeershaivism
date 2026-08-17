import { Link } from "react-router-dom";

interface Props {

    id: number;

    name: string;

    count: number;

}

function AuthorCard({

    id,

    name,

    count

}: Props) {

    return (

        <Link
            to={"/author/" + id}
            style={{
                textDecoration: "none",
                color: "inherit"
            }}
        >

            <div
                style={{
                    background: "#fff",
                    padding: 20,
                    borderRadius: 10,
                    boxShadow: "0 2px 10px rgba(0,0,0,.08)",
                    cursor: "pointer",
                    transition: ".2s"
                }}
            >

                <h3>{name}</h3>

                <p>{count} Vachanas</p>

            </div>

        </Link>

    );

}

export default AuthorCard;