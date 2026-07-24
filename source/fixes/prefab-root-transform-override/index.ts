import { debugLog, debugWarn } from '../../debug';

const PACKAGE_NAME = 'creator-editor-fixes';
const PATCHED_FLAG = '__prefabTransformOverrideFixerPatched__';
const ORIGINAL_METHOD = '__prefabTransformOverrideFixerOriginal__';
const PATCH_VERSION_FLAG = '__prefabTransformOverrideFixerPatchVersion__';
const PATCH_VERSION = 'override-recording-v5';
const STATE_KEY = '__prefabTransformOverrideFixerState__';

interface PatchRecord {
    target: any;
    key: string;
    original: (...args: any[]) => any;
    hadOwnDescriptor: boolean;
    ownDescriptor?: PropertyDescriptor;
}

interface ListenerState {
    installed: boolean;
    sceneReady?: boolean;
    patches: PatchRecord[];
    undoManager?: any;
    recordingId?: any;
    applyingDepth: number;
    sceneUndoManagerProto?: any;
    fixedCommandChildren?: WeakMap<any, string[]>;
    recentChildUuids?: string[];
}

interface PatchedMethod extends Function {
    [PATCHED_FLAG]?: boolean;
    [ORIGINAL_METHOD]?: (...args: any[]) => any;
    [PATCH_VERSION_FLAG]?: string;
}

/** 获取全局状态，支持扩展热重载后恢复旧 patch。 */
function getState(): ListenerState {
    const root = globalThis as any;
    if (!root[STATE_KEY]) root[STATE_KEY] = { installed: false, patches: [], applyingDepth: 0 } as ListenerState;
    const state = root[STATE_KEY] as ListenerState;
    if (!state.patches) state.patches = [];
    if (typeof state.applyingDepth !== 'number') state.applyingDepth = 0;
    if (!state.fixedCommandChildren) state.fixedCommandChildren = new WeakMap<any, string[]>();
    if (!state.recentChildUuids) state.recentChildUuids = [];
    return state;
}

/** 获取 Creator 内置 scene 包路径。 */
function getScenePackageRoot(): string | null {
    const editor = (globalThis as any).Editor;
    const appPath = editor && editor.App && editor.App.path;
    if (typeof appPath !== 'string' || appPath.length === 0) return null;
    return require('path').join(appPath, 'builtin', 'scene');
}

/** 安全格式化错误信息。 */
function formatError(error: any): string {
    try {
        const message = error && error.message;
        if (typeof message === 'string') return message.length > 160 ? `${message.slice(0, 160)}...` : message;
    } catch (_ignore) {
        return '<error-message-unavailable>';
    }

    try {
        const text = String(error);
        return text.length > 160 ? `${text.slice(0, 160)}...` : text;
    } catch (_ignore) {
        return '<error-string-unavailable>';
    }
}

/** 安全读取 Promise then，避免 getter 抛错。 */
function getPromiseThen(value: any): any {
    try {
        return value !== null && value !== undefined ? value.then : undefined;
    } catch (_ignore) {
        return undefined;
    }
}

/** 判断 recording id 是否有效。 */
function isValidRecordingId(value: any): boolean {
    return value !== undefined && value !== null && value !== '';
}

/** 安全获取 data descriptor 的值，避免触发 getter。 */
function getDataValue(obj: any, key: string): any {
    if (!obj) return undefined;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
    } catch (error) {
        return undefined;
    }
}

/** 安全获取自身 key，用于少量日志。 */
function getOwnKeys(value: any, limit = 20): string[] {
    if (!value) return [];
    try {
        return Object.getOwnPropertyNames(value).slice(0, limit);
    } catch (error) {
        return [];
    }
}

/** 安全获取 uuid 列表日志。 */
function formatUuidList(value: any, limit = 12): string {
    if (Array.isArray(value)) return `[${value.slice(0, limit).join(',')}${value.length > limit ? `,+${value.length - limit}` : ''}]`;
    if (value instanceof Map) {
        const keys: string[] = [];
        for (const key of value.keys()) {
            if (keys.length >= limit) break;
            keys.push(String(key));
        }
        return `[${keys.join(',')}${value.size > limit ? `,+${value.size - limit}` : ''}]`;
    }
    return '<none>';
}

/** 移除本次插入的 uuid。 */
function removeUuid(uuids: any[], uuid: string): void {
    const index = uuids.indexOf(uuid);
    if (index >= 0) uuids.splice(index, 1);
}

/** 记录由本插件补入原始 set-parent command 的 prefab 根节点。 */
function recordFixedCommandChild(command: any, childUuid: string): void {
    const state = getState();
    const fixedCommandChildren = state.fixedCommandChildren;
    if (!fixedCommandChildren || !command || !childUuid) return;
    let children = fixedCommandChildren.get(command);
    if (!children) {
        children = [];
        fixedCommandChildren.set(command, children);
    }
    if (!children.includes(childUuid)) children.push(childUuid);
    state.recentChildUuids = (state.recentChildUuids || []).filter((uuid) => uuid !== childUuid);
    state.recentChildUuids.unshift(childUuid);
    if (state.recentChildUuids.length > 20) state.recentChildUuids.length = 20;
}

/** 仅调整本次 applyData 的 child-first 顺序，不改变 command 持久记录顺序。 */
function createApplyDataMap(command: any, mapValue: any): any {
    if (!(mapValue instanceof Map)) return mapValue;
    const fixedCommandChildren = getState().fixedCommandChildren;
    const children = fixedCommandChildren && fixedCommandChildren.get(command);
    if (!children || children.length === 0) return mapValue;

    const reordered = new Map();
    for (const childUuid of children) {
        if (mapValue.has(childUuid)) reordered.set(childUuid, mapValue.get(childUuid));
    }
    if (reordered.size === 0) return mapValue;

    for (const entry of mapValue.entries()) {
        if (!reordered.has(entry[0])) reordered.set(entry[0], entry[1]);
    }
    debugLog(`[${PACKAGE_NAME}][${PATCH_VERSION}] applyData 使用 child-first 顺序 originalKeys=${formatUuidList(mapValue)} applyKeys=${formatUuidList(reordered)}`);
    return reordered;
}

/** 安全生成 applyData 入参；失败时回退到原入参，不阻断 Creator 原始逻辑。 */
function createApplyDataArgs(command: any, args: any[]): any[] {
    try {
        const mapValue = createApplyDataMap(command, args[0]);
        if (mapValue === args[0]) return args;
        const nextArgs = args.slice();
        nextArgs[0] = mapValue;
        return nextArgs;
    } catch (error) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] applyData 顺序调整失败，使用原始顺序: ${formatError(error)}`);
        return args;
    }
}

/** 安全读取节点字段。 */
function readNodeField(node: any, key: string): any {
    try {
        return node && node[key];
    } catch (error) {
        return undefined;
    }
}

/** 获取节点 uuid。 */
function getNodeUuid(node: any): string {
    return readNodeField(node, 'uuid') || readNodeField(node, '_uuid') || readNodeField(node, '_id') || '';
}

/** 获取节点名称。 */
function getNodeName(node: any): string {
    return readNodeField(node, 'name') || readNodeField(node, '_name') || getNodeUuid(node) || '<unnamed>';
}

/** 判断是否是 prefab 实例根节点。 */
function isPrefabRoot(node: any): boolean {
    const prefab = readNodeField(node, '_prefab');
    return !!(prefab && prefab.instance);
}

/** 格式化节点用于日志。 */
function formatNode(node: any): string {
    return `${getNodeName(node)}(${getNodeUuid(node) || 'no-uuid'})`;
}

/** 安全读取普通字段，优先 data descriptor，失败时返回 undefined。 */
function readAnyField(obj: any, key: string): any {
    const dataValue = getDataValue(obj, key);
    if (dataValue !== undefined) return dataValue;
    try {
        return obj && obj[key];
    } catch (_ignore) {
        return undefined;
    }
}

/** 克隆 Transform 值，优先使用引擎 clone。 */
function cloneTransformValue(sourceValue: any): any {
    if (!sourceValue || typeof sourceValue !== 'object') return sourceValue;
    try {
        if (typeof sourceValue.clone === 'function') return sourceValue.clone();
    } catch (_ignore) {
        // clone 失败时走字段复制兜底。
    }

    const cloned = Object.create(Object.getPrototypeOf(sourceValue));
    for (const key of ['x', 'y', 'z', 'w']) {
        const value = readAnyField(sourceValue, key);
        if (typeof value === 'number') {
            Object.defineProperty(cloned, key, {
                value,
                writable: true,
                enumerable: true,
                configurable: true,
            });
        }
    }
    return cloned;
}

/** 克隆条目并替换 value 字段。 */
function cloneEntryWithValue(entry: any, nextValue: any): any | null {
    if (!entry || typeof entry !== 'object') return null;
    const cloned = Object.create(Object.getPrototypeOf(entry));
    for (const key of Object.getOwnPropertyNames(entry)) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (!descriptor) continue;
        Object.defineProperty(cloned, key, key === 'value' && Object.prototype.hasOwnProperty.call(descriptor, 'value')
            ? { ...descriptor, value: nextValue }
            : descriptor);
    }
    if (!Object.prototype.hasOwnProperty.call(cloned, 'value')) return null;
    return cloned;
}

/** 读取条目的 localID。 */
function getEntryLocalId(entry: any): any {
    const direct = readAnyField(entry, 'localID') || readAnyField(entry, 'localId');
    if (direct) return direct;
    const targetInfo = readAnyField(entry, 'targetInfo') || readAnyField(entry, 'target');
    return readAnyField(targetInfo, 'localID') || readAnyField(targetInfo, 'localId');
}

/** 判断条目是否指向当前 prefab 根节点 localID。 */
function isEntryForLocalId(entry: any, fileId: string): boolean {
    const localId = getEntryLocalId(entry);
    if (localId === fileId) return true;
    return Array.isArray(localId) && localId.includes(fileId);
}

/** 判断条目是否对应指定 Transform 字段。 */
function isEntryForTransform(entry: any, transformKey: string): boolean {
    for (const key of ['propertyPath', 'path', 'property', 'name']) {
        const value = readAnyField(entry, key);
        if (value === transformKey) return true;
        if (Array.isArray(value) && value.includes(transformKey)) return true;
    }
    return false;
}

/** 获取 prefab 实例上的已有覆盖列表。 */
function getExistingOverrideList(child: any): any[] | null {
    const prefab = readNodeField(child, '_prefab');
    const instance = prefab && prefab.instance;
    const listKey = 'property' + 'Overrides';
    const list = readAnyField(instance, listKey) || readAnyField(prefab, listKey);
    return Array.isArray(list) ? list : null;
}

/** 更新已有 Transform 覆盖条目，返回回滚记录。 */
function updateExistingTransformEntries(child: any): Array<{ list: any[]; index: number; oldEntry: any }> {
    const prefab = readNodeField(child, '_prefab');
    const fileId = prefab && (prefab.fileId || prefab._fileId);
    const list = getExistingOverrideList(child);
    const rollback: Array<{ list: any[]; index: number; oldEntry: any }> = [];
    if (!fileId || !list) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 跳过覆盖同步：未找到 prefab 覆盖列表 child=${formatNode(child)}`);
        return rollback;
    }

    for (const transformKey of ['_lpos', '_lrot', '_euler', '_lscale']) {
        const sourceValue = readNodeField(child, transformKey);
        let updated = false;
        for (let index = 0; index < list.length; index++) {
            const entry = list[index];
            if (!isEntryForLocalId(entry, fileId) || !isEntryForTransform(entry, transformKey)) continue;
            const nextEntry = cloneEntryWithValue(entry, cloneTransformValue(sourceValue));
            if (!nextEntry) continue;
            rollback.push({ list, index, oldEntry: entry });
            list[index] = nextEntry;
            updated = true;
        }
        if (!updated) debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 缺少已有 Transform 覆盖条目 child=${formatNode(child)} key=${transformKey}`);
    }
    return rollback;
}

/** 同步已有 Transform 覆盖并刷新 redo dump。 */
function syncExistingTransformOverrides(manager: any, command: any): void {
    const state = getState();
    if (state.applyingDepth > 0) return;
    const fixedCommandChildren = state.fixedCommandChildren;
    const children = fixedCommandChildren ? fixedCommandChildren.get(command) : undefined;
    if (!children || children.length === 0) return;
    const proto = state.sceneUndoManagerProto;
    const setRedo = proto && unwrapMethod(proto._setRedo);
    if (typeof setRedo !== 'function') {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 跳过覆盖同步：未找到原始 _setRedo`);
        return;
    }

    const syncedNodes: string[] = [];
    for (const childUuid of children) {
        const child = findNodeByUuid(childUuid);
        if (!child || !isPrefabRoot(child)) {
            debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 跳过覆盖同步：child 不是 prefab 根节点 uuid=${childUuid}`);
            continue;
        }
        const rollback = updateExistingTransformEntries(child);
        if (rollback.length === 0) continue;
        try {
            setRedo.call(manager, command, childUuid);
            syncedNodes.push(formatNode(child));
        } catch (error) {
            for (let index = rollback.length - 1; index >= 0; index--) {
                const item = rollback[index];
                item.list[item.index] = item.oldEntry;
            }
            debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] _setRedo 失败，已回滚覆盖同步 child=${formatNode(child)}: ${formatError(error)}`);
        }
    }
    if (syncedNodes.length > 0) debugLog(`[${PACKAGE_NAME}][${PATCH_VERSION}] 已同步 prefab 根节点已有 Transform 覆盖 count=${syncedNodes.length} children=[${syncedNodes.join(',')}] redoKeys=${formatUuidList(getDataValue(command, 'redoData'))}`);
}

/** 递归查找 uuid 对应节点，只读场景树。 */
function findNodeInTree(root: any, uuid: string): any {
    if (!root) return null;
    if (getNodeUuid(root) === uuid) return root;
    const children = readNodeField(root, 'children') || readNodeField(root, '_children');
    if (!Array.isArray(children)) return null;
    for (const child of children) {
        const found = findNodeInTree(child, uuid);
        if (found) return found;
    }
    return null;
}

/** 按 uuid 查找节点，优先使用 cce.Node.query。 */
function findNodeByUuid(uuid: string): any {
    const root = globalThis as any;
    try {
        const query = root.cce && root.cce.Node && root.cce.Node.query;
        if (typeof query === 'function') {
            const node = query.call(root.cce.Node, uuid);
            if (node) return node;
        }
    } catch (error) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] Node.query 查找失败 uuid=${uuid}: ${formatError(error)}`);
    }
    return findNodeInTree(root.cce && root.cce.Scene && root.cce.Scene.rootNode, uuid);
}

/** 从命令列表中找当前 recording command。 */
function findCommandInList(list: any, recordingId: any): any {
    if (!Array.isArray(list) || list.length === 0) return null;
    for (let index = list.length - 1; index >= 0; index--) {
        const command = list[index];
        if (getDataValue(command, 'id') === recordingId) return command;
    }
    return null;
}

/** 定位当前 undo command。 */
function findActiveCommand(manager: any): any {
    const recordingId = getState().recordingId;
    if (!isValidRecordingId(recordingId)) return null;
    return findCommandInList(getDataValue(manager, '_manualCommands'), recordingId)
        || findCommandInList(getDataValue(manager, '_autoCommands'), recordingId);
}

/** 清理当前 recording 状态，避免误写已完成命令。 */
function clearActiveRecordingState(): void {
    const state = getState();
    state.undoManager = undefined;
    state.recordingId = undefined;
}

/** 取得已 patch 函数背后的原函数。 */
function unwrapMethod(method: any): any {
    return typeof method === 'function' && method[PATCHED_FLAG] && method[ORIGINAL_METHOD] ? method[ORIGINAL_METHOD] : method;
}

/** 安装 wrapper 并记录原 descriptor。 */
function patchMethod(target: any, key: string, factory: (original: (...args: any[]) => any) => (...args: any[]) => any): boolean {
    if (!target) return false;
    const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
    const hadOwnDescriptor = !!ownDescriptor;
    const original = unwrapMethod(target[key]);
    if (typeof original !== 'function') {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 跳过 patch ${key}: 不是函数`);
        return false;
    }
    const wrapped = factory(original) as PatchedMethod;
    wrapped[PATCHED_FLAG] = true;
    wrapped[ORIGINAL_METHOD] = original;
    wrapped[PATCH_VERSION_FLAG] = PATCH_VERSION;
    target[key] = wrapped;
    getState().patches.push({ target, key, original, hadOwnDescriptor, ownDescriptor });
    return true;
}

/** require Creator scene 内部模块。 */
function requireSceneModule(label: string, requestPath: string): any | null {
    try {
        return require(requestPath);
    } catch (error) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 加载 ${label} 失败: ${formatError(error)}`);
        return null;
    }
}

/** 获取命名导出或 default。 */
function getExport(moduleValue: any, key: string): any {
    return getDataValue(moduleValue, key) || getDataValue(moduleValue, 'default');
}

/** 调用原始 _setUndo，把 child 初始 dump 补进当前 command。 */
function addChildUndoDump(manager: any, command: any, childUuid: string, child: any): boolean {
    const uuids = getDataValue(command, 'uuids');
    if (!Array.isArray(uuids)) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 跳过 prefab 根节点：当前 command.uuids 不是数组 child=${formatNode(child)}`);
        return false;
    }

    const proto = getState().sceneUndoManagerProto;
    const setUndo = proto && unwrapMethod(proto._setUndo);
    if (typeof setUndo !== 'function') {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 跳过 prefab 根节点：未找到原始 _setUndo child=${formatNode(child)}`);
        return false;
    }

    const undoData = getDataValue(command, 'undoData');
    if (undoData instanceof Map && undoData.has(childUuid)) {
        recordFixedCommandChild(command, childUuid);
        return true;
    }

    const inserted = !uuids.includes(childUuid);
    if (inserted) uuids.push(childUuid);

    try {
        setUndo.call(manager, command, childUuid);
        const updatedUndoData = getDataValue(command, 'undoData');
        if (!(updatedUndoData instanceof Map) || !updatedUndoData.has(childUuid)) {
            if (inserted) removeUuid(uuids, childUuid);
            debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 补 prefab 根节点 undo dump 后未找到 child dump，已回滚 uuid child=${formatNode(child)} commandUuids=${formatUuidList(uuids)} undoKeys=${formatUuidList(updatedUndoData)}`);
            return false;
        }
        recordFixedCommandChild(command, childUuid);
        return true;
    } catch (error) {
        if (inserted) removeUuid(uuids, childUuid);
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 补 prefab 根节点 undo dump 失败 child=${formatNode(child)}: ${formatError(error)}`);
        return false;
    }
}

/** 在 setNodeParent 前扩展当前原始 recording 的 uuid/dump 范围。 */
function patchSetNodeParentBefore(payload: any): void {
    const state = getState();
    if (state.applyingDepth > 0) return;
    const uuids = payload && payload.uuids;
    if (!Array.isArray(uuids) || uuids.length === 0) return;
    const manager = state.undoManager;
    if (!manager) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 跳过 set-parent 修复：没有 active undo manager`);
        return;
    }
    const command = findActiveCommand(manager);
    if (!command) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 跳过 set-parent 修复：没有 active command managerKeys=[${getOwnKeys(manager).join(',')}]`);
        return;
    }

    const addedNodes: string[] = [];
    for (const uuid of uuids) {
        if (typeof uuid !== 'string' || !uuid) continue;
        const node = findNodeByUuid(uuid);
        if (!node || !isPrefabRoot(node)) continue;
        if (addChildUndoDump(manager, command, uuid, node)) addedNodes.push(formatNode(node));
    }
    if (addedNodes.length > 0) debugLog(`[${PACKAGE_NAME}][${PATCH_VERSION}] 已将 prefab 根节点加入当前 set-parent 记录 count=${addedNodes.length} children=[${addedNodes.join(',')}] commandUuids=${formatUuidList(getDataValue(command, 'uuids'))} undoKeys=${formatUuidList(getDataValue(command, 'undoData'))}`);
}

/** 安装最小修复 patch。 */
function installPatches(): void {
    const sceneRoot = getScenePackageRoot();
    if (!sceneRoot) {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 未找到 sceneRoot`);
        return;
    }
    const path = require('path');
    const generalFacadeModule = requireSceneModule('facade/general-scene-facade', path.join(sceneRoot, 'dist/script/3d/facade/general-scene-facade'));
    const undoSceneModule = requireSceneModule('export/undo/scene', path.join(sceneRoot, 'dist/script/export/undo/scene'));
    const GeneralSceneFacade = getExport(generalFacadeModule, 'GeneralSceneFacade');
    const SceneUndoManager = getDataValue(undoSceneModule, 'SceneUndoManager');
    const SceneUndoCommand = getDataValue(undoSceneModule, 'SceneUndoCommand');
    const state = getState();
    state.sceneUndoManagerProto = SceneUndoManager && SceneUndoManager.prototype;

    patchMethod(SceneUndoManager && SceneUndoManager.prototype, 'beginRecording', (original) => function patchedBeginRecording(this: any, ...args: any[]) {
        clearActiveRecordingState();
        const result = original.apply(this, args);
        if (isValidRecordingId(result)) {
            state.undoManager = this;
            state.recordingId = result;
        }
        return result;
    });

    patchMethod(GeneralSceneFacade && GeneralSceneFacade.prototype, 'setNodeParent', (original) => function patchedSetNodeParent(this: any, ...args: any[]) {
        try {
            patchSetNodeParentBefore(args[0]);
        } catch (error) {
            debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] set-parent 修复前置逻辑失败: ${formatError(error)}`);
        }
        return original.apply(this, args);
    });

    patchMethod(SceneUndoManager && SceneUndoManager.prototype, 'endRecording', (original) => function patchedEndRecording(this: any, ...args: any[]) {
        const command = findActiveCommand(this);
        try {
            const result = original.apply(this, args);
            if (command) {
                try {
                    syncExistingTransformOverrides(this, command);
                    debugLog(`[${PACKAGE_NAME}][${PATCH_VERSION}] endRecording 后校验 commandUuids=${formatUuidList(getDataValue(command, 'uuids'))} redoKeys=${formatUuidList(getDataValue(command, 'redoData'))}`);
                } catch (error) {
                    debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] endRecording 后校验日志失败: ${formatError(error)}`);
                }
            }
            return result;
        } finally {
            clearActiveRecordingState();
        }
    });

    const callWithApplyingGuard = (original: (...args: any[]) => any, self: any, args: any[]) => {
        state.applyingDepth++;
        try {
            const result = original.apply(self, args);
            const then = getPromiseThen(result);
            if (typeof then === 'function') {
                try {
                    const cleanupPromise = then.call(result,
                        () => { state.applyingDepth--; },
                        () => { state.applyingDepth--; },
                    );
                    if (cleanupPromise && typeof cleanupPromise.catch === 'function') cleanupPromise.catch(() => undefined);
                } catch (_ignore) {
                    state.applyingDepth--;
                }
                return result;
            }
            state.applyingDepth--;
            return result;
        } catch (error) {
            state.applyingDepth--;
            throw error;
        }
    };

    const applyingFactory = (original: (...args: any[]) => any) => function patchedApplying(this: any, ...args: any[]) {
        return callWithApplyingGuard(original, this, args);
    };
    const applyDataFactory = (original: (...args: any[]) => any) => function patchedApplyData(this: any, ...args: any[]) {
        return callWithApplyingGuard(original, this, createApplyDataArgs(this, args));
    };
    patchMethod(SceneUndoCommand && SceneUndoCommand.prototype, 'applyData', applyDataFactory);
    patchMethod(SceneUndoCommand && SceneUndoCommand.prototype, 'undo', applyingFactory);
    patchMethod(SceneUndoCommand && SceneUndoCommand.prototype, 'redo', applyingFactory);
}

/** 安装编辑器内部 hook。 */
export async function installEditorHooks(): Promise<void> {
    await uninstallEditorHooks();
    const state = getState();
    state.installed = true;
    installPatches();
    debugLog(`[${PACKAGE_NAME}][${PATCH_VERSION}] 已安装 override recording 最小修复 patches=${state.patches.length}`);
}

/** 记录 ready 状态，不影响 patch 是否生效。 */
export async function setSceneReadyState(isReady: boolean): Promise<void> {
    const state = getState();
    state.sceneReady = isReady;
    debugLog(`[${PACKAGE_NAME}][${PATCH_VERSION}] scene ready=${isReady}`);
}

/** 卸载全部 hook 并恢复原 descriptor。 */
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
    state.undoManager = undefined;
    state.recordingId = undefined;
    state.applyingDepth = 0;
}

export const methods: { [key: string]: (...args: any[]) => any } = {
    installEditorHooks,
    setSceneReadyState,
    uninstallEditorHooks,
};

/** 扩展卸载时恢复原函数。 */
export function unload(): void {
    uninstallEditorHooks().catch((error: unknown) => {
        debugWarn(`[${PACKAGE_NAME}][${PATCH_VERSION}] 卸载失败: ${formatError(error)}`);
    });
}
