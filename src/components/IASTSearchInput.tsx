import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

type IASTSearchInputProps = {
    value: string;
    onChange: (value: string) => void;
    onSubmit?: () => void;
    content: string;
    placeholder?: string;
    ariaLabel?: string;
};

function foldForSuggestion(value: string) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase();
}

function extractWords(content: string) {
    const words = content.match(/[\p{L}\p{M}]+(?:[-'][\p{L}\p{M}]+)*/gu) ?? [];
    const unique = new Map<string, string>();

    for (const word of words) {
        const clean = word.trim();
        if (!clean || clean.length < 2) continue;
        const folded = foldForSuggestion(clean);
        if (!unique.has(folded)) unique.set(folded, clean);
    }

    return [...unique.values()];
}

function hasDiacritic(value: string) {
    return /[āīūṛṝḷḹṅñṭḍṇśṣĀĪŪṚṜḶṄÑṬḌṆŚṢ]/u.test(value)
        || /[\u0300-\u036f]/u.test(value.normalize('NFD'));
}

export default function IASTSearchInput({
    value,
    onChange,
    onSubmit,
    content,
    placeholder = 'Search in this Grantha…',
    ariaLabel = 'Search in current Grantha',
}: IASTSearchInputProps) {
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const rootRef = useRef<HTMLDivElement>(null);

    const words = useMemo(() => extractWords(content), [content]);
    const suggestions = useMemo(() => {
        const query = foldForSuggestion(value.trim());
        if (!query) return [] as string[];

        const ranked = words
            .filter((word) => foldForSuggestion(word).startsWith(query))
            .sort((a, b) => {
                const aDiacritic = hasDiacritic(a) ? 0 : 1;
                const bDiacritic = hasDiacritic(b) ? 0 : 1;
                if (aDiacritic !== bDiacritic) return aDiacritic - bDiacritic;
                return a.localeCompare(b, undefined, { sensitivity: 'base' });
            });

        return ranked.slice(0, 8);
    }, [words, value]);

    useEffect(() => {
        setActiveIndex(0);
    }, [value]);

    useEffect(() => {
        function handlePointerDown(event: MouseEvent) {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        }
        document.addEventListener('mousedown', handlePointerDown);
        return () => document.removeEventListener('mousedown', handlePointerDown);
    }, []);

    function choose(word: string) {
        onChange(word);
        setOpen(false);
        setActiveIndex(0);
    }

    function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
        if (!open || suggestions.length === 0) {
            if (event.key === 'Enter') onSubmit?.();
            if (event.key === 'Escape') setOpen(false);
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((index) => (index + 1) % suggestions.length);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            choose(suggestions[activeIndex]);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
        }
    }

    return (
        <div className="iasts-search-input" ref={rootRef}>
            <span className="granthas-search-icon" aria-hidden="true">⌕</span>
            <input
                type="search"
                value={value}
                onChange={(event) => { onChange(event.target.value); setOpen(true); }}
                onFocus={() => setOpen(true)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                aria-label={ariaLabel}
                aria-autocomplete="list"
                aria-expanded={open && suggestions.length > 0}
            />
            {value && <button type="button" className="granthas-search-clear" onClick={() => { onChange(''); setOpen(false); }} aria-label="Clear search">✕</button>}
            {open && suggestions.length > 0 && (
                <div className="iasts-suggestions" role="listbox" aria-label="IAST word suggestions">
                    {suggestions.map((word, index) => (
                        <button
                            type="button"
                            key={`${word}-${index}`}
                            className={`iasts-suggestion ${index === activeIndex ? 'is-active' : ''}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => choose(word)}
                            role="option"
                            aria-selected={index === activeIndex}
                        >
                            <span>{word}</span>
                            {hasDiacritic(word) && <small>IAST</small>}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
