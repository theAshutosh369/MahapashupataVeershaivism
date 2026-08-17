export interface AuthorSummary {

    id: number;

    kannadaName: string;

    englishName: string;

    count: number;

    file: string;
}

export interface Vachana {

    authorId: number;

    number: number;

    akshara: string;

    kannada: string;

    transliteration: string;

    translation: string | null;
}

export interface Author {

    id: number;

    kannadaName: string;

    englishName: string;

    vachanas: Vachana[];
}