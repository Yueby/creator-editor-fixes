export const DEBUG = false;

const DEBUG_GLOBAL_KEY = '__creatorEditorFixesDebug__';

export function isDebugEnabled(): boolean {
    return DEBUG || (globalThis as any)[DEBUG_GLOBAL_KEY] === true;
}

export function debugLog(...args: any[]): void {
    if (isDebugEnabled()) console.log(...args);
}

export function debugWarn(...args: any[]): void {
    if (isDebugEnabled()) console.warn(...args);
}
