import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};
let installed = false;

function istTimestamp() {
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false,
    }).format(new Date()).replace(',', '');
}
function stringify(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
}
function install() {
    if (installed) return;
    installed = true;
    for (const level of ['log', 'info', 'warn', 'error']) {
        console[level] = (...args) => {
            const store = storage.getStore();
            if (store) store.logs.push({ time: istTimestamp(), level, message: args.map(stringify).join(' ') });
            original[level](...args);
        };
    }
}
export function withRequestLogs(requestId, fn) {
    install();
    const state = { requestId, logs: [] };
    return storage.run(state, async () => {
        try {
            return { result: await fn(), state };
        } catch (error) {
            error.requestLogState = state;
            throw error;
        }
    });
}
export function getRequestLogs(state) { return Array.isArray(state?.logs) ? [...state.logs] : []; }
export function createRequestLogId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
