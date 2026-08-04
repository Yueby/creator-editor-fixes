/**
 * 本扩展的所有修复都基于 Cocos Creator 3.8.3 的编辑器内部实现验证过。
 * 其它版本的 scene / undo / inspector 内部结构可能不同，一律不安装 hook。
 */
export const SUPPORTED_EDITOR_VERSION = '3.8.3';

/** 安全读取当前编辑器版本，读不到时返回空字符串。 */
export function getEditorVersion(): string {
    try {
        const editor = (globalThis as any).Editor;
        const version = editor && editor.App && editor.App.version;
        return typeof version === 'string' ? version : '';
    } catch (_error) {
        return '';
    }
}

/** 是否是本扩展验证过的编辑器版本。 */
export function isSupportedEditorVersion(): boolean {
    return getEditorVersion() === SUPPORTED_EDITOR_VERSION;
}
