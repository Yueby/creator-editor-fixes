import { debugWarn, warnOnce } from '../../debug';
import { getEditorVersion, isSupportedEditorVersion, SUPPORTED_EDITOR_VERSION } from '../../editor-version';

const PACKAGE_NAME = 'creator-editor-fixes';
const PATCH_VERSION = 'prefab-active-override-sync-v1';
const STATE_KEY = '__prefabActiveOverrideSyncState__';
const PATCHED_FLAG = '__prefabActiveOverrideSyncPatched__';
const ORIGINAL_KEY = '__prefabActiveOverrideSyncOriginal__';
/** 快捷键 toggle-active-selected-node 最终调用的 facade 方法。 */
const TOGGLE_METHOD = 'toggleActiveSelectedNode';

interface PatchRecord {
    target: any;
    key: string;
    hadOwnDescriptor: boolean;
    ownDescriptor?: PropertyDescriptor;
}

interface State {
    installed: boolean;
    patches: PatchRecord[];
}

function getState(): State {
    const root = globalThis as any;
    if (!root[STATE_KEY]) root[STATE_KEY] = { installed: false, patches: [] } as State;
    const state = root[STATE_KEY] as State;
    if (!Array.isArray(state.patches)) state.patches = [];
    return state;
}

function readField(value: any, key: string): any {
    try {
        return value && value[key];
    } catch (_error) {
        return undefined;
    }
}

function getUuid(node: any): string {
    return readField(node, 'uuid') || readField(node, '_uuid') || readField(node, '_id') || '';
}

function getParent(node: any): any {
    return readField(node, 'parent') || readField(node, '_parent');
}

function isPrefabInstanceRoot(node: any): boolean {
    const prefab = readField(node, '_prefab');
    return !!(prefab && readField(prefab, 'instance'));
}

// 节点自身是预制体实例根，或位于某个预制体实例内部时，它的 active 才会走 propertyOverrides。
function isInsidePrefabInstance(node: any): boolean {
    let current = node;
    while (current) {
        if (isPrefabInstanceRoot(current)) return true;
        current = getParent(current);
    }
    return false;
}

function getSelectedNodeUuids(): string[] {
    try {
        const editor = (globalThis as any).Editor;
        const selected = editor && editor.Selection && editor.Selection.getSelected('node');
        return Array.isArray(selected) ? selected.filter((uuid: any) => typeof uuid === 'string' && uuid) : [];
    } catch (error) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 读取选中节点失败:`, error);
        return [];
    }
}

function findNodeByUuid(uuid: string): any {
    try {
        const nodeManager = (globalThis as any).cce && (globalThis as any).cce.Node;
        return nodeManager && typeof nodeManager.query === 'function' ? nodeManager.query(uuid) : null;
    } catch (error) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] Node.query 失败 uuid=${uuid}:`, error);
        return null;
    }
}

function getSceneRoot(): any {
    const root = globalThis as any;
    return root.cce && root.cce.Scene && readField(root.cce.Scene, 'rootNode');
}

// 快捷键路径只改了 node.active，没有像 Inspector 的 set-property 那样通知 PrefabManager，
// 所以不会往 PrefabInstance.propertyOverrides 写 _active，保存/切场景后状态丢失。
// 这里在原方法执行后补一次与 Inspector 相同的节点变更通知。
function syncActiveOverrides(prefabManager: any, uuids: string[]): void {
    if (!prefabManager || typeof prefabManager.onNodeChangedInGeneralMode !== 'function') return;
    const sceneRoot = getSceneRoot();
    for (const uuid of uuids) {
        const node = findNodeByUuid(uuid);
        if (!node || !isInsidePrefabInstance(node)) continue;
        try {
            prefabManager.onNodeChangedInGeneralMode(
                node,
                { source: 'editor', type: 'set-property', propPath: 'active', record: false },
                readField(node, 'scene') || sceneRoot || null,
            );
        } catch (error) {
            debugWarn(`[${PATCH_VERSION}] 同步 active override 失败 uuid=${getUuid(node)}:`, error);
        }
    }
}

function unwrap(method: any): any {
    return method && method[PATCHED_FLAG] ? method[ORIGINAL_KEY] : method;
}

function patchMethod(target: any, key: string): boolean {
    if (!target) return false;
    const original = unwrap(target[key]);
    if (typeof original !== 'function') return false;

    const wrapped = function patchedToggleActiveSelectedNode(this: any, ...args: any[]): any {
        const uuids = getSelectedNodeUuids();
        const result = original.apply(this, args);
        const sync = (): void => {
            try { syncActiveOverrides(this && this._prefabMgr, uuids); } catch (error) { debugWarn(`[${PATCH_VERSION}] active override 同步失败:`, error); }
        };
        const then = result && result.then;
        if (typeof then === 'function') {
            return then.call(result, (value: any) => {
                sync();
                return value;
            });
        }
        sync();
        return result;
    } as any;
    wrapped[PATCHED_FLAG] = true;
    wrapped[ORIGINAL_KEY] = original;

    const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
    target[key] = wrapped;
    getState().patches.push({ target, key, hadOwnDescriptor: !!ownDescriptor, ownDescriptor });
    return true;
}

function getGeneralSceneFacade(): any {
    try {
        const root = globalThis as any;
        const appPath = root.Editor && root.Editor.App && root.Editor.App.path;
        if (typeof appPath !== 'string' || !appPath) return null;
        const path = require('path');
        const moduleValue = require(path.join(appPath, 'builtin', 'scene', 'dist/script/3d/facade/general-scene-facade'));
        return readField(moduleValue, 'GeneralSceneFacade') || readField(moduleValue, 'default');
    } catch (error) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 加载 GeneralSceneFacade 失败:`, error);
        return null;
    }
}

export async function installEditorHooks(): Promise<void> {
    await uninstallEditorHooks();
    if (!isSupportedEditorVersion()) {
        warnOnce(
            `${PACKAGE_NAME}:${PATCH_VERSION}:unsupported-version`,
            `[${PACKAGE_NAME}][${PATCH_VERSION}] 跳过安装：仅适用于编辑器 ${SUPPORTED_EDITOR_VERSION}，当前 ${getEditorVersion() || 'unknown'}`,
        );
        return;
    }
    const facade = getGeneralSceneFacade();
    const installed = patchMethod(facade && facade.prototype, TOGGLE_METHOD);
    if (!installed) {
        warnOnce(
            `${PACKAGE_NAME}:${PATCH_VERSION}:patch-failed`,
            `[${PACKAGE_NAME}][${PATCH_VERSION}] 未能 hook GeneralSceneFacade.${TOGGLE_METHOD}，快捷键取消激活的 prefab 节点不会保存`,
        );
    }
    getState().installed = installed;
}

export async function setSceneReadyState(_isReady: boolean): Promise<void> {
    // 无需随场景状态变化的逻辑，保持与其它修复模块一致的接口。
}

export async function uninstallEditorHooks(): Promise<void> {
    const state = getState();
    for (let index = state.patches.length - 1; index >= 0; index--) {
        const patch = state.patches[index];
        if (patch.target && patch.target[patch.key] && patch.target[patch.key][PATCHED_FLAG]) {
            if (patch.hadOwnDescriptor && patch.ownDescriptor) Object.defineProperty(patch.target, patch.key, patch.ownDescriptor);
            else delete patch.target[patch.key];
        }
    }
    state.patches = [];
    state.installed = false;
}

export function unload(): void {
    uninstallEditorHooks().catch((error: unknown) => {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 卸载失败:`, error);
    });
}
