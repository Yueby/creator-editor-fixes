const PACKAGE_NAME = 'prefab-transform-override-fixer';

interface NodeDumpLike {
    [key: string]: any;
}

type TransformPropertyPath = 'position' | 'rotation' | 'scale';

interface TransformPropertyPayload {
    path: TransformPropertyPath;
    dump: NodeDumpLike;
}

interface FixPrefabNodeTransformPayload {
    uuid: string;
    name: string;
    properties: TransformPropertyPayload[];
}

const TRANSFORM_PROPERTY_PATHS: TransformPropertyPath[] = ['position', 'rotation', 'scale'];

const parentUuidCache = new Map<string, string>();
const pendingPayloadList: FixPrefabNodeTransformPayload[] = [];
const pendingNodeCheckTimerSet = new Set<ReturnType<typeof setTimeout>>();

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let refreshCacheTimer: ReturnType<typeof setTimeout> | null = null;

/** 判断是否是普通对象 */
function isObject(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null;
}

/** 从 dump 字段中提取字符串值 */
function getStringValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!isObject(value)) return '';

    if (typeof value.value === 'string') return value.value;
    if (isObject(value.value)) {
        if (typeof value.value.uuid === 'string') return value.value.uuid;
        if (typeof value.value.__uuid__ === 'string') return value.value.__uuid__;
        if (typeof value.value.value === 'string') return value.value.value;
    }

    if (typeof value.uuid === 'string') return value.uuid;
    if (typeof value.__uuid__ === 'string') return value.__uuid__;
    return '';
}

/** 获取节点 uuid */
function getNodeUuid(dump: NodeDumpLike | null | undefined): string {
    if (!dump) return '';
    return getStringValue(dump.uuid) || getStringValue(dump._id) || getStringValue(dump.id);
}

/** 获取节点名称 */
function getNodeName(dump: NodeDumpLike): string {
    return getStringValue(dump.name) || getStringValue(dump._name) || getNodeUuid(dump);
}

/** 兼容不同 dump 结构提取 uuid */
function getUuidFromUnknown(value: unknown): string {
    const directValue = getStringValue(value);
    if (directValue) return directValue;

    if (!isObject(value)) return '';

    for (const key of ['uuid', '_id', 'id', '__uuid__']) {
        const uuid = getStringValue(value[key]);
        if (uuid) return uuid;
    }

    if (isObject(value.value)) {
        return getUuidFromUnknown(value.value);
    }

    return '';
}

/** 获取父节点 uuid */
function getParentUuid(dump: NodeDumpLike): string {
    return getUuidFromUnknown(dump.parent) || getUuidFromUnknown(dump._parent);
}

/** 从广播参数中尝试提取 parent uuid */
function collectParentUuidFromArgs(args: unknown[]): string {
    for (const arg of args) {
        if (!isObject(arg)) continue;

        const parentUuid = getUuidFromUnknown(arg.parent)
            || getUuidFromUnknown(arg.parentUuid)
            || getUuidFromUnknown(arg.parentUUID)
            || getUuidFromUnknown(arg.target)
            || getUuidFromUnknown(arg.targetUuid)
            || getUuidFromUnknown(arg.targetUUID);

        if (parentUuid) return parentUuid;
    }

    return '';
}

/** 判断节点 dump 是否是预制体实例根节点 */
function isPrefabInstanceRootDump(dump: NodeDumpLike): boolean {
    if (dump._prefabInstance) return true;
    if (dump.prefabInstance) return true;

    const prefabDump = dump.__prefab__ || dump._prefab;
    if (!isObject(prefabDump)) return false;

    if (prefabDump.instance) return true;
    if (isObject(prefabDump.value) && prefabDump.value.instance) return true;
    return false;
}

/** 深拷贝 dump，避免把 query-node 返回对象直接传回编辑器内部引用 */
function cloneDump<T>(dump: T): T {
    return JSON.parse(JSON.stringify(dump)) as T;
}

/** 收集节点完整 Transform 属性 dump */
function collectTransformPropertyDumps(dump: NodeDumpLike): TransformPropertyPayload[] {
    const properties: TransformPropertyPayload[] = [];

    for (const path of TRANSFORM_PROPERTY_PATHS) {
        const propertyDump = dump[path];
        if (!isObject(propertyDump) || !('value' in propertyDump)) continue;

        properties.push({
            path,
            dump: cloneDump(propertyDump),
        });
    }

    return properties;
}

/** 从广播参数里提取 uuid */
function collectUuidsFromArgs(args: unknown[], output = new Set<string>()): Set<string> {
    for (const arg of args) {
        if (typeof arg === 'string') {
            output.add(arg);
            continue;
        }

        if (Array.isArray(arg)) {
            collectUuidsFromArgs(arg, output);
            continue;
        }

        if (!isObject(arg)) continue;

        const uuid = getNodeUuid(arg);
        if (uuid) output.add(uuid);

        if (Array.isArray(arg.uuids)) collectUuidsFromArgs(arg.uuids, output);
        if (Array.isArray(arg.uuidList)) collectUuidsFromArgs(arg.uuidList, output);
    }

    return output;
}

/** 查询节点 dump */
async function queryNodeDump(uuid: string): Promise<NodeDumpLike | null> {
    try {
        return await Editor.Message.request('scene', 'query-node', uuid) as NodeDumpLike;
    } catch (_error) {
        return null;
    }
}

/** 递归记录当前场景节点父子关系 */
function cacheNodeTreeParentUuids(nodeDumpList: NodeDumpLike[]): number {
    let count = 0;

    const visit = (dump: NodeDumpLike) => {
        const uuid = getNodeUuid(dump);
        if (uuid) {
            parentUuidCache.set(uuid, getParentUuid(dump));
            count++;
        }

        const children = Array.isArray(dump.children) ? dump.children : [];
        for (const child of children) {
            if (isObject(child)) visit(child);
        }
    };

    for (const dump of nodeDumpList) {
        if (isObject(dump)) visit(dump);
    }

    return count;
}

/** 刷新当前场景父节点缓存 */
async function rebuildParentUuidCache(): Promise<void> {
    try {
        const isReady = await Editor.Message.request('scene', 'query-is-ready') as boolean;
        if (!isReady) return;

        const nodeTree = await Editor.Message.request('scene', 'query-node-tree') as unknown as NodeDumpLike[];
        parentUuidCache.clear();
        const count = cacheNodeTreeParentUuids(Array.isArray(nodeTree) ? nodeTree : []);
        console.log(`[${PACKAGE_NAME}] 已监听 scene 广播，缓存节点数: ${count}`);
    } catch (_error) {
        // 场景未就绪时忽略，等待 scene:ready 广播再刷新。
    }
}

/** 延迟刷新缓存，兼容扩展重载时场景已经打开的情况 */
function scheduleRebuildParentUuidCache(): void {
    if (refreshCacheTimer) clearTimeout(refreshCacheTimer);
    refreshCacheTimer = setTimeout(() => {
        refreshCacheTimer = null;
        rebuildParentUuidCache();
    }, 200);
}

/** 判断是否需要处理本次 parent 变化 */
async function shouldFixAfterParentChange(dump: NodeDumpLike, isAddNode: boolean, broadcastParentUuid = ''): Promise<boolean> {
    const uuid = getNodeUuid(dump);
    if (!uuid) return false;

    const oldParentUuid = parentUuidCache.get(uuid);
    const newParentUuid = getParentUuid(dump) || broadcastParentUuid;
    parentUuidCache.set(uuid, newParentUuid);

    if (!newParentUuid) return false;
    if (isAddNode && oldParentUuid === newParentUuid) return false;
    if (!isAddNode && oldParentUuid === newParentUuid) return false;

    console.log(`[${PACKAGE_NAME}] 捕获 prefab parent 变化: ${getNodeName(dump)} ${oldParentUuid || '<unknown>'} -> ${newParentUuid}`);

    return true;
}

/** 发送 Transform 的 set-property，让编辑器写入 prefab override/dirty 链路 */
async function setPrefabNodeTransform(payload: FixPrefabNodeTransformPayload): Promise<void> {
    for (const property of payload.properties) {
        await Editor.Message.request('scene', 'set-property', {
            uuid: payload.uuid,
            path: property.path,
            dump: property.dump as any,
            record: true,
        });
    }
}

/** 批量执行广播产生的修复请求，并只做一次 snapshot */
async function flushPendingFixes(): Promise<void> {
    const payloads = pendingPayloadList.splice(0, pendingPayloadList.length);
    flushTimer = null;

    if (payloads.length === 0) return;

    for (const payload of payloads) {
        await setPrefabNodeTransform(payload);
    }
    await Editor.Message.request('scene', 'snapshot');

    console.log(`[${PACKAGE_NAME}] 已自动写入 ${payloads.length} 个 prefab 节点 Transform override`);
}

/** 加入自动修复队列，防止广播短时间内重复触发 */
function enqueueFixPayload(payload: FixPrefabNodeTransformPayload): void {
    pendingPayloadList.push(payload);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        flushPendingFixes().catch((error) => {
            console.error(`[${PACKAGE_NAME}] 自动写入失败:`, error);
        });
    }, 80);
}

/** 从节点 dump 创建修复请求 */
function enqueueFixFromDump(dump: NodeDumpLike): void {
    if (!isPrefabInstanceRootDump(dump)) return;

    const uuid = getNodeUuid(dump);
    const properties = collectTransformPropertyDumps(dump);
    if (!uuid || properties.length === 0) return;

    enqueueFixPayload({
        uuid,
        name: getNodeName(dump),
        properties,
    });
}

/** 处理 scene:add-node / scene:change-node 广播 */
async function processSceneNodeBroadcast(uuid: string, isAddNode: boolean, broadcastParentUuid = ''): Promise<void> {
    const dump = await queryNodeDump(uuid);
    if (!dump) return;

    if (!isPrefabInstanceRootDump(dump)) {
        parentUuidCache.set(uuid, getParentUuid(dump) || broadcastParentUuid);
        return;
    }

    if (!await shouldFixAfterParentChange(dump, isAddNode, broadcastParentUuid)) return;

    enqueueFixFromDump(dump);
}

/** 延迟处理节点广播，等待 Creator 更新完节点 dump */
function scheduleSceneNodeBroadcastCheck(uuid: string, isAddNode: boolean, broadcastParentUuid = ''): void {
    if (!uuid) return;

    for (const delay of [0, 50]) {
        const timer = setTimeout(() => {
            pendingNodeCheckTimerSet.delete(timer);
            processSceneNodeBroadcast(uuid, isAddNode, broadcastParentUuid).catch((error) => {
                console.error(`[${PACKAGE_NAME}] 处理 scene 节点广播失败:`, error);
            });
        }, delay);
        pendingNodeCheckTimerSet.add(timer);
    }
}

/** 清理全部缓存和延迟任务 */
function clearRuntimeState(): void {
    if (flushTimer) clearTimeout(flushTimer);
    if (refreshCacheTimer) clearTimeout(refreshCacheTimer);

    for (const timer of pendingNodeCheckTimerSet.values()) {
        clearTimeout(timer);
    }

    flushTimer = null;
    refreshCacheTimer = null;
    pendingNodeCheckTimerSet.clear();
    pendingPayloadList.length = 0;
    parentUuidCache.clear();
}

export const methods: { [key: string]: (...args: any[]) => any } = {
    /** scene:ready 广播 */
    async onSceneReady() {
        await rebuildParentUuidCache();
    },

    /** scene:close 广播 */
    onSceneClose() {
        clearRuntimeState();
    },

    /** scene:add-node 广播：新拖入 prefab 时直接写入一次当前 Transform */
    onSceneAddNode(...args: unknown[]) {
        const parentUuid = collectParentUuidFromArgs(args);
        for (const uuid of collectUuidsFromArgs(args)) {
            scheduleSceneNodeBroadcastCheck(uuid, true, parentUuid);
        }
    },

    /** scene:change-node 广播：仅 parent 改变时同步 Transform */
    onSceneChangeNode(...args: unknown[]) {
        const parentUuid = collectParentUuidFromArgs(args);
        for (const uuid of collectUuidsFromArgs(args)) {
            scheduleSceneNodeBroadcastCheck(uuid, false, parentUuid);
        }
    },

    /** scene:remove-node 广播 */
    onSceneRemoveNode(...args: unknown[]) {
        for (const uuid of collectUuidsFromArgs(args)) {
            for (let i = pendingPayloadList.length - 1; i >= 0; i--) {
                if (pendingPayloadList[i].uuid === uuid) pendingPayloadList.splice(i, 1);
            }
            parentUuidCache.delete(uuid);
        }
    },
};

/** 扩展启动时触发 */
export function load() {
    scheduleRebuildParentUuidCache();
}

/** 扩展卸载时触发 */
export function unload() {
    clearRuntimeState();
}
