import { useEffect, useState } from "react";

function ScrollNavigator() {
    const [scrollY, setScrollY] = useState(0);
    const [windowHeight, setWindowHeight] = useState(0);
    const [documentHeight, setDocumentHeight] = useState(0);

    useEffect(() => {
        function handleScroll() {
            setScrollY(window.scrollY);
            setWindowHeight(window.innerHeight);
            setDocumentHeight(document.documentElement.scrollHeight);
        }

        // Use requestAnimationFrame for throttling
        let ticking = false;
        function onScroll() {
            if (!ticking) {
                requestAnimationFrame(() => {
                    handleScroll();
                    ticking = false;
                });
                ticking = true;
            }
        }

        // Initial values
        handleScroll();

        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", handleScroll, { passive: true });

        return () => {
            window.removeEventListener("scroll", onScroll);
            window.removeEventListener("resize", handleScroll);
        };
    }, []);

    const THRESHOLD = 200; // px from top/bottom to determine "near"
    const FADE_THRESHOLD = 150; // px to show the navigator

    const isPastFadeThreshold = scrollY > FADE_THRESHOLD;
    const isNearTop = scrollY < THRESHOLD;
    const isNearBottom = documentHeight - scrollY - windowHeight < THRESHOLD;

    // Determine which buttons to show
    const showTop = !isNearTop; // Show ↑ when not at top
    const showBottom = !isNearBottom; // Show ↓ when not at bottom

    // Only show at least one button when past fade threshold
    const isVisible = isPastFadeThreshold && (showTop || showBottom);

    function scrollToTop() {
        window.scrollTo({
            top: 0,
            behavior: "smooth",
        });
    }

    function scrollToBottom() {
        window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: "smooth",
        });
    }

    return (
        <div
            className={`scroll-navigator ${isVisible ? "scroll-navigator--visible" : "scroll-navigator--hidden"}`}
            aria-hidden={!isVisible}
        >
            {showTop && (
                <button
                    type="button"
                    className="scroll-navigator__btn scroll-navigator__btn--top"
                    onClick={scrollToTop}
                    aria-label="Scroll to top"
                    title="Scroll to top"
                >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 15l-6-6-6 6" />
                    </svg>
                </button>
            )}
            {showBottom && (
                <button
                    type="button"
                    className="scroll-navigator__btn scroll-navigator__btn--bottom"
                    onClick={scrollToBottom}
                    aria-label="Scroll to bottom"
                    title="Scroll to bottom"
                >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 9l6 6 6-6" />
                    </svg>
                </button>
            )}
        </div>
    );
}

export default ScrollNavigator;

