import { useEffect, useState } from "react";

import "../styles/components/scroll-navigator.css";

type ScrollNavigatorProps = {
    pathname?: string;
};

function ScrollNavigator({ pathname = "/" }: ScrollNavigatorProps) {
    const [scrollY, setScrollY] = useState(0);
    const [windowHeight, setWindowHeight] = useState(0);
    const [documentHeight, setDocumentHeight] = useState(0);

    useEffect(() => {
        function getTargetElement() {
            if (pathname === "/agent") {
                const chatMessages = document.querySelector(".ai-chat-messages");
                if (chatMessages instanceof HTMLElement) {
                    return chatMessages;
                }
            }

            return null;
        }

        function handleScroll() {
            const target = getTargetElement();

            if (target) {
                setScrollY(target.scrollTop);
                setWindowHeight(target.clientHeight);
                setDocumentHeight(target.scrollHeight);
                return;
            }

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

        const target = getTargetElement();
        if (target) {
            target.addEventListener("scroll", onScroll, { passive: true });
        } else {
            window.addEventListener("scroll", onScroll, { passive: true });
        }

        window.addEventListener("resize", handleScroll, { passive: true });

        return () => {
            if (target) {
                target.removeEventListener("scroll", onScroll);
            } else {
                window.removeEventListener("scroll", onScroll);
            }
            window.removeEventListener("resize", handleScroll);
        };
    }, [pathname]);

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
        const target = pathname === "/agent"
            ? document.querySelector(".ai-chat-messages")
            : null;

        if (target instanceof HTMLElement) {
            target.scrollTo({
                top: 0,
                behavior: "smooth",
            });
            return;
        }

        window.scrollTo({
            top: 0,
            behavior: "smooth",
        });
    }

    function scrollToBottom() {
        const target = pathname === "/agent"
            ? document.querySelector(".ai-chat-messages")
            : null;

        if (target instanceof HTMLElement) {
            target.scrollTo({
                top: target.scrollHeight,
                behavior: "smooth",
            });
            return;
        }

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
