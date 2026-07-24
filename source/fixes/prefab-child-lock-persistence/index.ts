import { debugWarn } from '../../debug';

const PACKAGE_NAME = 'creator-editor-fixes';
const PATCH_VERSION = 'prefab-child-lock-persistence-v4';
const STATE_KEY = '__prefabChildLockPersistenceState__';
const PATCHED_FLAG = '__prefabChildLockPersistencePatched__';

interface PatchRecord {
    target: any;
    key: string;
    original: (...args: any[]) => any;
    hadOwnDescriptor: boolean;
    ownDescriptor?: PropertyDescriptor;
}

interface State {
    installed: boolean;
    patches: PatchRecord[];
    restoring: boolean;
}

function getState(): State {
    const root = globalThis as any;
    if (!root[STATE_KEY]) root[STATE_KEY] = { installed: false, patches: [], restoring: false } as State;
    const state = root[STATE_KEY] as State;
    if (!Array.isArray(state.patches)) state.patches = [];
    if (typeof state.restoring !== 'boolean') state.restoring = false;
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

function getChildren(node: any): any[] {
    const children = readField(node, 'children') || readField(node, '_children');
    return Array.isArray(children) ? children : [];
}

function isPrefabInstanceRoot(node: any): boolean {
    const prefab = readField(node, '_prefab');
    return !!(prefab && readField(prefab, 'instance'));
}

function getParent(node: any): any {
    return readField(node, 'parent') || readField(node, '_parent');
}

function getPrefabLocalId(node: any): any {
    const prefab = readField(node, '_prefab');
    return readField(prefab, 'fileId') || readField(prefab, '_fileId')
        || readField(prefab, 'localID') || readField(prefab, 'localId');
}

// 预制体实例根节点的稳定标识：PrefabInstance.fileId。
// 它序列化在场景文件里、每个实例唯一、跨编辑器重启稳定；
// 而运行时节点 uuid 是实例化时生成的，重启后会变，不能用作持久化 key。
function getPrefabInstanceFileId(node: any): string {
    const prefab = readField(node, '_prefab');
    const instance = readField(prefab, 'instance');
    const fileId = readField(instance, 'fileId') || readField(instance, '_fileId');
    return typeof fileId === 'string' ? fileId : '';
}

function findOwner(node: any): any {
    let current = getParent(node);
    while (current) {
        if (isPrefabInstanceRoot(current)) return current;
        current = getParent(current);
    }
    return null;
}

function findNodeByUuid(uuid: string): any {
    const root = globalThis as any;
    try {
        const nodeManager = root.cce && root.cce.Node;
        if (nodeManager && typeof nodeManager.query === 'function') {
            const node = nodeManager.query(uuid);
            if (node) return node;
        }
    } catch (error) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] Node.query 失败 uuid=${uuid}:`, error);
    }

    const sceneRoot = root.cce && root.cce.Scene && readField(root.cce.Scene, 'rootNode');
    const visit = (node: any): any => {
        if (!node) return null;
        if (getUuid(node) === uuid) return node;
        for (const child of getChildren(node)) {
            const found = visit(child);
            if (found) return found;
        }
        return null;
    };
    return visit(sceneRoot);
}

function collectTargets(uuids: any, loop: any): any[] {
    const values = Array.isArray(uuids) ? uuids : [uuids];
    const targets: any[] = [];
    const add = (node: any): void => {
        if (!node || targets.includes(node)) return;
        targets.push(node);
        if (loop === true) {
            for (const child of getChildren(node)) add(child);
        }
    };
    for (const uuid of values) {
        if (typeof uuid !== 'string' || !uuid) continue;
        add(findNodeByUuid(uuid));
    }
    return targets;
}

function getLocked(node: any): boolean | undefined {
    try {
        if (typeof node.locked === 'boolean') return node.locked;
    } catch (_error) {
        // Read the editor flag when the public property is unavailable.
    }
    try {
        const flags = node && node._objFlags;
        return typeof flags === 'number' ? (flags & 512) !== 0 : undefined;
    } catch (_error) {
        return undefined;
    }
}

function getSceneUuid(): string {
    const root = globalThis as any;
    const sceneRoot = root.cce && root.cce.Scene && readField(root.cce.Scene, 'rootNode');
    return getUuid(sceneRoot);
}

function persistTargets(targets: any[]): void {
    if (getState().restoring) return;
    const changes: any[] = [];
    for (const node of targets) {
        const owner = findOwner(node);
        const localId = getPrefabLocalId(node);
        // 只排除顶层预制体根节点与普通节点（无预制体 owner，锁定由 Creator 原生序列化）。
        // 嵌套预制体根节点自身 isPrefabInstanceRoot=true，但它是外层预制体的子节点，锁定不会被原生保存，仍需持久化。
        if (!owner || localId === undefined || localId === null || localId === '') continue;
        const ownerFileId = getPrefabInstanceFileId(owner);
        if (!ownerFileId) continue;
        const locked = getLocked(node);
        if (locked === undefined) continue;
        changes.push({ prefabRootFileId: ownerFileId, childFileId: String(localId), locked });
    }
    const sceneUuid = getSceneUuid();
    if (!sceneUuid || !changes.length) return;
    try {
        const editor = (globalThis as any).Editor;
        const request = editor && editor.Message && editor.Message.request;
        if (typeof request === 'function') {
            Promise.resolve(request.call(editor.Message, PACKAGE_NAME, 'savePrefabChildLockStates', sceneUuid, changes)).catch((error: unknown) => {
                debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] locked 状态保存失败:`, error);
            });
        }
    } catch (error) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] locked 状态保存失败:`, error);
    }
}

async function restoreStates(): Promise<void> {
    const state = getState();
    if (state.restoring) return;
    const sceneUuid = getSceneUuid();
    if (!sceneUuid) return;
    const root = globalThis as any;
    const map = await root.Editor.Message.request(PACKAGE_NAME, 'getPrefabChildLockStates');
    const sceneMap = map && map.scenes && map.scenes[sceneUuid];
    if (!sceneMap) return;
    const nodeManager = root.cce && root.cce.Node;
    if (!nodeManager || typeof nodeManager.changeNodeLock !== 'function') return;
    const sceneRoot = root.cce && root.cce.Scene && readField(root.cce.Scene, 'rootNode');
    const visit = async (node: any): Promise<void> => {
        if (!node) return;
        const owner = findOwner(node);
        const localId = getPrefabLocalId(node);
        const ownerFileId = owner ? getPrefabInstanceFileId(owner) : '';
        if (ownerFileId && localId !== undefined && localId !== null && localId !== '') {
            const rootMap = sceneMap[ownerFileId];
            const locked = rootMap && rootMap[String(localId)];
            if (typeof locked === 'boolean') await Promise.resolve(nodeManager.changeNodeLock(getUuid(node), locked, false));
        }
        for (const child of getChildren(node)) await visit(child);
    };
    state.restoring = true;
    try { await visit(sceneRoot); } finally { state.restoring = false; }
}

function unwrap(method: any): any {
    return method && method[PATCHED_FLAG] ? method.__prefabChildLockPersistenceOriginal__ : method;
}

function patchMethod(target: any, key: string): boolean {
    if (!target) return false;
    const current = target[key];
    const original = unwrap(current);
    if (typeof original !== 'function') return false;

    const wrapped = function patchedChangeNodeLock(this: any, ...args: any[]): any {
        const targets = collectTargets(args[0], args[2]);
        if (getState().restoring) return original.apply(this, args);
        let result: any;
        try {
            result = original.apply(this, args);
        } catch (error) {
            throw error;
        }

        const then = result && result.then;
        if (typeof then === 'function') {
            return then.call(result, (value: any) => {
                try { persistTargets(targets); } catch (error) { debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] locked override 持久化失败:`, error); }
                return value;
            });
        }
        try { persistTargets(targets); } catch (error) { debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] locked override 持久化失败:`, error); }
        return result;
    } as any;
    (wrapped as any)[PATCHED_FLAG] = true;
    (wrapped as any).__prefabChildLockPersistenceOriginal__ = original;

    const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
    target[key] = wrapped;
    getState().patches.push({ target, key, original, hadOwnDescriptor: !!ownDescriptor, ownDescriptor });
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
    const facade = getGeneralSceneFacade();
    const installed = patchMethod(facade && facade.prototype, 'changeNodeLock');
    getState().installed = installed;
}

export async function setSceneReadyState(isReady: boolean): Promise<void> {
    if (isReady) {
        try { await restoreStates(); } catch (error) { debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 恢复 locked 状态失败:`, error); }
    } else {
        getState().restoring = false;
    }
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
    state.restoring = false;
}

export const methods: { [key: string]: (...args: any[]) => any } = {
    installEditorHooks,
    setSceneReadyState,
    uninstallEditorHooks,
};

export function unload(): void {
    uninstallEditorHooks().catch((error: unknown) => {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 卸载失败:`, error);
    });
}
