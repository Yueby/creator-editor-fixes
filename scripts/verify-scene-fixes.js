// scene 进程三个 hook 的离线冒烟测试：用假的编辑器内部实现（SceneUndoManager / SceneUndoCommand /
// GeneralSceneFacade / cce.Node / cce.Scene）真跑一遍 dist 产物，覆盖手工点编辑器很难稳定复现的分支。
//
// 用法：node scripts/verify-scene-fixes.js（不需要安装 Cocos Creator）

const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');
const PACKAGE_NAME = 'creator-editor-fixes';

let failed = 0;

function check(condition, message) {
    if (condition) console.log(`[OK]   ${message}`);
    else {
        failed++;
        console.log(`[FAIL] ${message}`);
    }
}

// ---------------------------------------------------------------- 假编辑器内部实现

const FAKE_FACADE_SOURCE = `
class GeneralSceneFacade {
    constructor() {
        this._prefabMgr = GeneralSceneFacade.prefabMgr;
    }
    toggleActiveSelectedNode() {
        GeneralSceneFacade.toggleCalls = (GeneralSceneFacade.toggleCalls || 0) + 1;
        for (const uuid of GeneralSceneFacade.selected) {
            const node = GeneralSceneFacade.nodes.get(uuid);
            if (node) node.active = !node.active;
        }
    }
    async setNodeParent(options) {
        GeneralSceneFacade.lastOptions = options;
        return [];
    }
    async changeNodeLock(uuids, locked, loop) {
        GeneralSceneFacade.lastLock = { uuids, locked, loop };
    }
}
GeneralSceneFacade.selected = [];
GeneralSceneFacade.nodes = new Map();
exports.GeneralSceneFacade = GeneralSceneFacade;
`;

const FAKE_UNDO_SOURCE = `
let counter = 0;
class SceneUndoCommand {
    constructor(id) {
        this.id = id;
        this.uuids = [];
        this.undoData = new Map();
        this.redoData = new Map();
        this.appliedKeys = [];
    }
    async applyData(data) {
        this.appliedKeys = Array.from(data.keys());
    }
    async undo() {
        await this.applyData(this.undoData);
    }
    async redo() {
        await this.applyData(this.redoData);
    }
}
class SceneUndoManager {
    constructor() {
        this._manualCommands = [];
        this._autoCommands = [];
    }
    beginRecording(uuids) {
        const command = new SceneUndoCommand('cmd-' + (++counter));
        command.uuids = Array.isArray(uuids) ? uuids.slice() : [uuids];
        for (const uuid of command.uuids) this._setUndo(command, uuid);
        this._manualCommands.push(command);
        return command.id;
    }
    endRecording() {
        return true;
    }
    _setUndo(command, uuid) {
        command.undoData.set(uuid, { dump: 'undo:' + uuid });
    }
    _setRedo(command, uuid) {
        command.redoData.set(uuid, { dump: 'redo:' + uuid });
    }
}
exports.SceneUndoManager = SceneUndoManager;
exports.SceneUndoCommand = SceneUndoCommand;
`;

function createFakeCreatorRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-editor-fixes-smoke-'));
    const facadeDir = path.join(root, 'builtin', 'scene', 'dist', 'script', '3d', 'facade');
    const undoDir = path.join(root, 'builtin', 'scene', 'dist', 'script', 'export', 'undo');
    fs.mkdirSync(facadeDir, { recursive: true });
    fs.mkdirSync(undoDir, { recursive: true });
    fs.writeFileSync(path.join(facadeDir, 'general-scene-facade.js'), FAKE_FACADE_SOURCE);
    fs.writeFileSync(path.join(undoDir, 'scene.js'), FAKE_UNDO_SOURCE);
    return root;
}

// ---------------------------------------------------------------- 假场景树

class Vec3Like {
    constructor(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }
    clone() {
        return new Vec3Like(this.x, this.y, this.z);
    }
}

class TargetInfo {
    constructor(localID) {
        this.localID = localID;
    }
}

class PropertyOverrideInfo {
    constructor(localID, propertyPath, value) {
        this.targetInfo = new TargetInfo(localID);
        this.propertyPath = propertyPath;
        this.value = value;
    }
}

/** 模拟引擎 PrefabInstance.findPropertyOverride：严格比较字符串数组。 */
function makePrefabInstance(fileId, propertyOverrides, withEngineApi) {
    const instance = { fileId, propertyOverrides };
    if (withEngineApi) {
        instance.findPropertyOverride = function findPropertyOverride(localID, propPath) {
            const same = (a, b) => Array.isArray(a) && a.length === b.length && b.every((item, index) => a[index] === item);
            return this.propertyOverrides.find((entry) => same(entry.targetInfo.localID, localID) && same(entry.propertyPath, propPath)) || null;
        };
    }
    return instance;
}

function makeNode(name, uuid) {
    return { name, uuid, children: [], parent: null, _objFlags: 0 };
}

function addChild(parent, child) {
    child.parent = parent;
    parent.children.push(child);
    return child;
}

/** prefab 根节点：Transform override 走 propertyOverrides，附带两条必须被忽略的干扰条目。 */
function makePrefabRoot(uuid, rootFileId, withEngineApi) {
    const node = makeNode('PrefabRoot', uuid);
    node._lpos = new Vec3Like(10, 20, 30);
    node._lrot = new Vec3Like(0, 0, 0);
    node._euler = new Vec3Like(0, 0, 0);
    node._lscale = new Vec3Like(1, 1, 1);

    const correct = new PropertyOverrideInfo([rootFileId], ['_lpos'], new Vec3Like(1, 1, 1));
    const nestedNoise = new PropertyOverrideInfo(['OUTER', rootFileId], ['_lpos'], new Vec3Like(7, 7, 7));
    const componentNoise = new PropertyOverrideInfo([rootFileId], ['_lpos', 'x'], 7);
    const overrides = [
        nestedNoise,
        componentNoise,
        correct,
        new PropertyOverrideInfo([rootFileId], ['_lrot'], new Vec3Like(0, 0, 0)),
        new PropertyOverrideInfo([rootFileId], ['_euler'], new Vec3Like(0, 0, 0)),
        new PropertyOverrideInfo([rootFileId], ['_lscale'], new Vec3Like(1, 1, 1)),
    ];
    node._prefab = { fileId: rootFileId, instance: makePrefabInstance('INSTANCE-' + uuid, overrides, withEngineApi) };
    return { node, overrides, correct, nestedNoise, componentNoise };
}

// ---------------------------------------------------------------- 环境搭建

const creatorRoot = createFakeCreatorRoot();
const nodeIndex = new Map();
const messageCalls = [];
const lockCalls = [];
let profileStub = { version: 1, scenes: {} };
let sceneRootNode = null;
let selectedUuids = [];
const nodeChangeCalls = [];

function indexTree(node) {
    if (!node) return;
    nodeIndex.set(node.uuid, node);
    for (const child of node.children) indexTree(child);
}

global.Editor = {
    App: { path: creatorRoot, version: '3.8.3' },
    Selection: {
        getSelected: () => selectedUuids.slice(),
    },
    Message: {
        request: async (packageName, method, ...args) => {
            messageCalls.push({ packageName, method, args });
            if (method === 'getPrefabChildLockStates') return profileStub;
            return undefined;
        },
    },
};

global.cce = {
    Node: {
        query: (uuid) => nodeIndex.get(uuid) || null,
        changeNodeLock: (uuid, locked) => {
            lockCalls.push({ uuid, locked });
            const node = nodeIndex.get(uuid);
            if (node) node._objFlags = locked ? node._objFlags | 512 : node._objFlags & ~512;
        },
    },
    Scene: {
        get rootNode() {
            return sceneRootNode;
        },
    },
};

const sceneEntry = require(path.join(DIST_DIR, 'scene.js'));
const facadeModule = require(path.join(creatorRoot, 'builtin', 'scene', 'dist', 'script', '3d', 'facade', 'general-scene-facade'));
const undoModule = require(path.join(creatorRoot, 'builtin', 'scene', 'dist', 'script', 'export', 'undo', 'scene'));
const { GeneralSceneFacade } = facadeModule;
const { SceneUndoManager } = undoModule;

// ---------------------------------------------------------------- fix1

async function verifyTransformOverrideFix(withEngineApi) {
    const label = withEngineApi ? '引擎 findPropertyOverride 路径' : '严格比较回退路径';
    console.log(`\n--- fix1 prefab-root-transform-override（${label}）---`);

    nodeIndex.clear();
    const scene = makeNode('Scene', 'scene-uuid');
    const parentA = addChild(scene, makeNode('ParentA', 'parent-a'));
    const parentB = addChild(scene, makeNode('ParentB', 'parent-b'));
    const prefab = makePrefabRoot('prefab-root', 'ROOT_FILE', withEngineApi);
    addChild(parentA, prefab.node);
    sceneRootNode = scene;
    indexTree(scene);

    await sceneEntry.installEditorHooks();
    check(GeneralSceneFacade.prototype.setNodeParent.__prefabTransformOverrideFixerPatched__ === true, 'setNodeParent 已被 hook');
    check(SceneUndoManager.prototype.endRecording.__prefabTransformOverrideFixerPatched__ === true, 'endRecording 已被 hook');

    const manager = new SceneUndoManager();
    const facade = new GeneralSceneFacade();

    // uuids 传单个字符串（CutNodeOptions 允许 string），旧实现会直接跳过修复
    const recordingId = manager.beginRecording(['parent-a', 'parent-b']);
    await facade.setNodeParent({ parent: 'parent-b', uuids: 'prefab-root' });
    const command = manager._manualCommands.find((item) => item.id === recordingId);
    check(command.uuids.includes('prefab-root'), 'uuids 为 string 时也把 prefab 根节点补进 command.uuids');
    check(command.undoData.has('prefab-root'), 'prefab 根节点的 reparent 前 dump 已进 undoData');

    // reparent 后节点实时 Transform 变化，endRecording 时应回写进已有 override
    prefab.node._lpos = new Vec3Like(111, 222, 333);
    manager.endRecording(recordingId);

    const strictSame = (value, expected) => Array.isArray(value) && value.length === expected.length && expected.every((item, index) => value[index] === item);
    const synced = prefab.overrides.find((entry) => strictSame(entry.propertyPath, ['_lpos']) && strictSame(entry.targetInfo.localID, ['ROOT_FILE']));
    check(!!synced && synced !== prefab.correct, '已有 _lpos override 条目被替换为新条目（不改写原对象）');
    check(prefab.correct.value.x === 1, '原条目对象保持不变，undo dump 里的旧值不会被污染');
    check(synced.value.x === 111 && synced.value.y === 222 && synced.value.z === 333, '_lpos override 值已同步为节点实时值');
    check(synced.value !== prefab.node._lpos, 'override value 是克隆值，不与节点共享引用');
    check(prefab.nestedNoise.value.x === 7, "嵌套 localID ['OUTER','ROOT_FILE'] 的干扰条目未被改动");
    check(prefab.componentNoise.value === 7, "分量级 propertyPath ['_lpos','x'] 的干扰条目未被改动");
    check(command.redoData.has('prefab-root'), '同步后的 prefab 根节点状态已进同一个 command 的 redoData');

    // endRecording 传别人的 id 时，不能把当前 recording 状态清掉
    const secondId = manager.beginRecording(['parent-a']);
    manager.endRecording('bogus-recording-id');
    await facade.setNodeParent({ parent: 'parent-a', uuids: ['prefab-root'] });
    const secondCommand = manager._manualCommands.find((item) => item.id === secondId);
    check(secondCommand.uuids.includes('prefab-root'), 'endRecording 收到无关 id 时，当前 recording 仍能继续补 child');
    manager.endRecording(secondId);

    // applyData 使用 child-first 顺序
    const applyMap = new Map([['parent-a', {}], ['parent-b', {}], ['prefab-root', {}]]);
    await command.applyData(applyMap);
    check(command.appliedKeys[0] === 'prefab-root', 'applyData 使用 child-first 顺序，prefab 根节点先应用');

    await sceneEntry.uninstallEditorHooks();
    check(!GeneralSceneFacade.prototype.setNodeParent.__prefabTransformOverrideFixerPatched__, 'uninstall 后 setNodeParent 已还原');
    check(!SceneUndoManager.prototype.applyData, 'uninstall 后原型上没有残留 wrapper');
}

// ---------------------------------------------------------------- fix3

async function verifyChildLockFix() {
    console.log('\n--- fix3 prefab-child-lock-persistence ---');

    nodeIndex.clear();
    messageCalls.length = 0;
    lockCalls.length = 0;

    // 同一个外层 prefab 实例里放两份相同的嵌套 prefab：子节点自身 fileId 相同，只有路径不同
    const scene = makeNode('Scene', 'scene-uuid');
    const outer = addChild(scene, makeNode('OuterPrefab', 'outer-root'));
    outer._prefab = { fileId: 'OUTER_FILE', instance: makePrefabInstance('OUTER_INSTANCE', [], true) };

    const nestedA = addChild(outer, makeNode('NestedA', 'nested-a'));
    nestedA._prefab = { fileId: 'N_A', instance: makePrefabInstance('NESTED_A_INSTANCE', [], true) };
    const childA = addChild(nestedA, makeNode('Child', 'child-a'));
    childA._prefab = { fileId: 'C1' };

    const nestedB = addChild(outer, makeNode('NestedB', 'nested-b'));
    nestedB._prefab = { fileId: 'N_B', instance: makePrefabInstance('NESTED_B_INSTANCE', [], true) };
    const childB = addChild(nestedB, makeNode('Child', 'child-b'));
    childB._prefab = { fileId: 'C1' };

    sceneRootNode = scene;
    indexTree(scene);

    await sceneEntry.installEditorHooks();
    check(GeneralSceneFacade.prototype.changeNodeLock.__prefabChildLockPersistencePatched__ === true, 'changeNodeLock 已被 hook');

    const facade = new GeneralSceneFacade();
    childA._objFlags |= 512;
    await facade.changeNodeLock('child-a', true, false);
    await new Promise((resolve) => setImmediate(resolve));

    const saveCall = messageCalls.find((call) => call.method === 'savePrefabChildLockStates');
    check(!!saveCall, '锁定 prefab 子节点后发出 savePrefabChildLockStates');
    const change = saveCall && saveCall.args[1][0];
    check(!!change && change.prefabRootFileId === 'NESTED_A_INSTANCE', 'owner 取最近的 prefab 实例根（嵌套 prefab 自身）');
    check(!!change && change.childFileId === 'C1', '单层子节点的 key 就是自身 fileId');
    check(!!change && change.locked === true, '持久化的 locked 值正确');

    // 跨一层普通节点：key 必须是 owner -> child 的完整 fileId 路径，避免与 childB 撞 key
    messageCalls.length = 0;
    const deepChild = addChild(childA, makeNode('DeepChild', 'deep-child'));
    deepChild._prefab = { fileId: 'C2' };
    indexTree(scene);
    deepChild._objFlags |= 512;
    await facade.changeNodeLock('deep-child', true, false);
    await new Promise((resolve) => setImmediate(resolve));
    const deepChange = messageCalls.find((call) => call.method === 'savePrefabChildLockStates').args[1][0];
    check(deepChange.childFileId === 'C1/C2', `多级子节点 key 使用 fileId 路径（实际 ${deepChange.childFileId}）`);

    // 顶层 prefab 根节点由 Creator 原生序列化，不应持久化
    messageCalls.length = 0;
    outer._objFlags |= 512;
    await facade.changeNodeLock('outer-root', true, false);
    await new Promise((resolve) => setImmediate(resolve));
    check(!messageCalls.some((call) => call.method === 'savePrefabChildLockStates'), '顶层 prefab 根节点不写 Profile');

    // 恢复：新格式 key + 旧格式 key（v4 只存子节点自身 fileId）都要能命中
    lockCalls.length = 0;
    messageCalls.length = 0;
    profileStub = {
        version: 1,
        scenes: {
            'scene-uuid': {
                NESTED_A_INSTANCE: { 'C1/C2': true },
                NESTED_B_INSTANCE: { C1: true },
            },
        },
    };
    await sceneEntry.setSceneReadyState(true);
    check(lockCalls.some((call) => call.uuid === 'deep-child' && call.locked === true), '恢复命中新格式路径 key');
    check(lockCalls.some((call) => call.uuid === 'child-b' && call.locked === true), '恢复兼容 v4 旧格式 key');
    check(!lockCalls.some((call) => call.uuid === 'child-a'), '未记录的节点不被恢复');
    check(!messageCalls.some((call) => call.method === 'savePrefabChildLockStates'), '恢复期间不会回写 Profile（restoring 保护生效）');

    await sceneEntry.uninstallEditorHooks();
    check(!GeneralSceneFacade.prototype.changeNodeLock.__prefabChildLockPersistencePatched__, 'uninstall 后 changeNodeLock 已还原');
}

// ---------------------------------------------------------------- fix4

async function verifyActiveOverrideSync() {
    console.log('\n--- fix4 prefab-active-override-sync ---');

    nodeIndex.clear();
    nodeChangeCalls.length = 0;

    const scene = makeNode('Scene', 'scene-uuid');
    const plain = addChild(scene, makeNode('Plain', 'plain'));
    const instanceRoot = addChild(scene, makeNode('InstanceRoot', 'instance-root'));
    instanceRoot._prefab = { fileId: 'ROOT', instance: makePrefabInstance('INSTANCE', [], true) };
    const inner = addChild(instanceRoot, makeNode('Inner', 'inner'));
    inner._prefab = { fileId: 'INNER' };
    for (const node of [plain, instanceRoot, inner]) node.active = true;
    sceneRootNode = scene;
    indexTree(scene);

    GeneralSceneFacade.nodes = nodeIndex;
    GeneralSceneFacade.prefabMgr = {
        onNodeChangedInGeneralMode: (node, opts, root) => nodeChangeCalls.push({ uuid: node.uuid, opts, root }),
    };

    await sceneEntry.installEditorHooks();
    check(GeneralSceneFacade.prototype.toggleActiveSelectedNode.__prefabActiveOverrideSyncPatched__ === true, 'toggleActiveSelectedNode 已被 hook');

    const facade = new GeneralSceneFacade();
    GeneralSceneFacade.selected = selectedUuids = ['plain', 'instance-root', 'inner'];
    facade.toggleActiveSelectedNode();
    check(GeneralSceneFacade.toggleCalls === 1 && !instanceRoot.active && !plain.active, '原方法照常执行，激活状态被切换');
    check(nodeChangeCalls.length === 2, `只对 prefab 实例内的节点补发变更通知（实际 ${nodeChangeCalls.length} 次）`);
    check(nodeChangeCalls.some((call) => call.uuid === 'instance-root'), '实例根节点被通知');
    check(nodeChangeCalls.some((call) => call.uuid === 'inner'), '实例内部子节点被通知');
    check(!nodeChangeCalls.some((call) => call.uuid === 'plain'), '普通节点不通知');
    const call = nodeChangeCalls[0];
    check(call.opts.propPath === 'active' && call.opts.record === false, '通知参数 propPath=active 且不记录 undo');
    check(call.root === scene, 'root 取场景根节点');

    await sceneEntry.uninstallEditorHooks();
    check(!GeneralSceneFacade.prototype.toggleActiveSelectedNode.__prefabActiveOverrideSyncPatched__, 'uninstall 后 toggleActiveSelectedNode 已还原');
}

// ---------------------------------------------------------------- 版本守卫

async function verifyVersionGuard() {
    console.log('\n--- 版本守卫 ---');
    global.Editor.App.version = '3.8.4';
    await sceneEntry.installEditorHooks();
    check(!GeneralSceneFacade.prototype.setNodeParent.__prefabTransformOverrideFixerPatched__, '非 3.8.3 时不安装 fix1 hook');
    check(!GeneralSceneFacade.prototype.changeNodeLock.__prefabChildLockPersistencePatched__, '非 3.8.3 时不安装 fix3 hook');
    check(!GeneralSceneFacade.prototype.toggleActiveSelectedNode.__prefabActiveOverrideSyncPatched__, '非 3.8.3 时不安装 fix4 hook');
    global.Editor.App.version = '3.8.3';
    await sceneEntry.uninstallEditorHooks();
}

async function main() {
    try {
        await verifyTransformOverrideFix(true);
        await verifyTransformOverrideFix(false);
        await verifyChildLockFix();
        await verifyActiveOverrideSync();
        await verifyVersionGuard();
    } finally {
        fs.rmSync(creatorRoot, { recursive: true, force: true });
    }

    console.log('');
    if (failed > 0) {
        console.error(`Scene fixes smoke test failed: ${failed} 项不通过`);
        process.exit(1);
    }
    console.log('Scene fixes smoke test passed.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
