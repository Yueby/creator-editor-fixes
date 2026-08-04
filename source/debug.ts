export const DEBUG = false;

const DEBUG_GLOBAL_KEY = '__creatorEditorFixesDebug__';
const WARN_ONCE_GLOBAL_KEY = '__creatorEditorFixesWarnedKeys__';

export function isDebugEnabled(): boolean {
    return DEBUG || (globalThis as any)[DEBUG_GLOBAL_KEY] === true;
}

export function debugLog(...args: any[]): void {
    if (isDebugEnabled()) console.log(...args);
}

export function debugWarn(...args: any[]): void {
    if (isDebugEnabled()) console.warn(...args);
}

/**
 * 关键失败提示：不受 DEBUG 开关影响，否则修复静默失效时用户拿不到任何线索。
 * 同一个 key 只输出一次，避免在高频路径里刷控制台。
 */
export function warnOnce(key: string, ...args: any[]): void {
    const root = globalThis as any;
    if (!root[WARN_ONCE_GLOBAL_KEY]) root[WARN_ONCE_GLOBAL_KEY] = {};
    const warned = root[WARN_ONCE_GLOBAL_KEY];
    if (warned[key]) return;
    warned[key] = true;
    try {
        console.warn(...args);
    } catch (_error) {
        // 控制台不可用时忽略。
    }
}
