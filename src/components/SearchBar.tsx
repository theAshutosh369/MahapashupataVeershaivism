type Props = {
    value: string;
    onChange: (value: string) => void;
};

function SearchBar({ value, onChange }: Props) {
    return (
        <input
            type="text"
            value={value}
            placeholder="Search Vachanakar..."
            onChange={(e) => onChange(e.target.value)}
            className="form-input"
            style={{ maxWidth: "100%" }}
        />
    );
}

export default SearchBar;

