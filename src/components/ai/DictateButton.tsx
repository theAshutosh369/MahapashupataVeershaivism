import { useEffect, useRef, useState } from 'react';

type SpeechRecognitionResultLike = {
    isFinal: boolean;
    0: { transcript: string };
    length: number;
};

type SpeechRecognitionEventLike = Event & {
    resultIndex: number;
    results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionErrorEventLike = Event & {
    error: string;
    message?: string;
};

type SpeechRecognitionLike = {
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    lang: string;
    onstart: (() => void) | null;
    onend: (() => void) | null;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    start: () => void;
    stop: () => void;
    abort: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type DictateButtonProps = {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    language?: string;
};

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
    if (typeof window === 'undefined') return null;
    const speechWindow = window as Window & {
        SpeechRecognition?: SpeechRecognitionConstructor;
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition || null;
}

function appendTranscript(base: string, transcript: string) {
    const clean = transcript.trim();
    if (!clean) return base;
    if (!base.trim()) return clean;
    return `${base.replace(/\s+$/, '')} ${clean}`;
}

export default function DictateButton({ value, onChange, disabled = false, language }: DictateButtonProps) {
    const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
    const baseValueRef = useRef('');
    const finalTranscriptRef = useRef('');
    const [listening, setListening] = useState(false);
    const [supported, setSupported] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        setSupported(Boolean(getSpeechRecognition()));
        return () => {
            recognitionRef.current?.abort();
            recognitionRef.current = null;
        };
    }, []);

    function stopRecognition() {
        recognitionRef.current?.stop();
    }

    function startRecognition() {
        const SpeechRecognition = getSpeechRecognition();
        if (!SpeechRecognition || disabled || listening) return;

        setError('');
        baseValueRef.current = value;
        finalTranscriptRef.current = '';

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.lang = language || (typeof navigator !== 'undefined' ? navigator.language : 'en-IN');

        recognition.onstart = () => {
            setListening(true);
        };

        recognition.onresult = (event) => {
            let interimTranscript = '';
            let newFinalTranscript = finalTranscriptRef.current;

            for (let i = event.resultIndex; i < event.results.length; i += 1) {
                const result = event.results[i];
                const transcript = result?.[0]?.transcript || '';
                if (result.isFinal) {
                    newFinalTranscript += `${transcript} `;
                } else {
                    interimTranscript += transcript;
                }
            }

            finalTranscriptRef.current = newFinalTranscript;
            onChange(appendTranscript(baseValueRef.current, `${newFinalTranscript}${interimTranscript}`));
        };

        recognition.onerror = (event) => {
            if (event.error === 'aborted') return;
            const messages: Record<string, string> = {
                'not-allowed': 'Microphone permission was denied.',
                'service-not-allowed': 'Speech recognition is not allowed in this browser.',
                'no-speech': 'No speech was detected. Try again.',
                'audio-capture': 'No microphone was available.',
                'network': 'Speech recognition could not reach the browser speech service.'
            };
            setError(messages[event.error] || 'Speech recognition failed.');
            setListening(false);
        };

        recognition.onend = () => {
            setListening(false);
            recognitionRef.current = null;
        };

        recognitionRef.current = recognition;
        try {
            recognition.start();
        } catch {
            recognitionRef.current = null;
            setListening(false);
            setError('Could not start microphone dictation.');
        }
    }

    function handleClick() {
        if (listening) stopRecognition();
        else startRecognition();
    }

    return (
        <div className="ai-dictate-wrap">
            <button
                type="button"
                className={`ai-dictate-btn${listening ? ' is-listening' : ''}`}
                onClick={handleClick}
                disabled={disabled || !supported}
                aria-label={listening ? 'Stop dictation' : 'Dictate question'}
                title={
                    !supported
                        ? 'Voice dictation is not supported by this browser'
                        : listening
                            ? 'Stop dictation'
                            : 'Dictate question'
                }
            >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="9" y="2" width="6" height="12" rx="3" />
                    <path d="M5 10a7 7 0 0 0 14 0" />
                    <path d="M12 19v3" />
                    <path d="M8 22h8" />
                </svg>
                {listening && <span className="ai-dictate-pulse" aria-hidden="true" />}
            </button>
            {error && <span className="ai-dictate-error" role="status">{error}</span>}
        </div>
    );
}
