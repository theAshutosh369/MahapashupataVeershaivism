type Props = {

    value: string;

    onChange: (value: string) => void;

};

function SearchBar({

    value,

    onChange

}: Props) {

    return (

        <input

            type="text"

            value={value}

            placeholder="Search Vachanakar..."

            onChange={(e) => onChange(e.target.value)}

            style={{

                width: "100%",

                maxWidth: 650,

                padding: 16,

                fontSize: 18,

                borderRadius: 10,

                border: "1px solid #ccc"

            }}

        />

    );

}

export default SearchBar;