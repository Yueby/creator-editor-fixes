// 校验本扩展 hook 的 Cocos Creator 3.8.3 编辑器内部 API 与引擎字段是否仍然成立。
//
// 数据来源：
//   1. <Creator>/resources/app.asar 内的 builtin/scene/@types/**.d.ts（scene 包实现是加密 .ccc，但类型定义是明文）
//   2. <Creator>/resources/resources/3d/engine/cocos/**.ts（引擎源码是明文）
//   3. dist 产物（确认已按当前 source 重新构建）
//
// 用法：
//   node scripts/verify-editor-internals.js
//   COCOS_CREATOR_383_PATH=/path/to/Creator/3.8.3 node scripts/verify-editor-internals.js

const fs = require('fs');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');
const EXPECTED_EDITOR_VERSION = '3.8.3';

let failed = 0;

function ok(message) {
    console.log(`[OK]   ${message}`);
}

function fail(message) {
    failed++;
    console.log(`[FAIL] ${message}`);
}

function check(condition, message) {
    if (condition) ok(message);
    else fail(message);
}

function getCreatorRoot() {
    if (process.env.COCOS_CREATOR_383_PATH) return process.env.COCOS_CREATOR_383_PATH;
    const candidates = [
        'C:\\ProgramData\\cocos\\editors\\Creator\\3.8.3',
        'C:\\Program Files\\Cocos\\Creator\\3.8.3',
        'D:\\ProgramData\\cocos\\editors\\Creator\\3.8.3',
        'E:\\ProgramData\\cocos\\editors\\Creator\\3.8.3',
        '/Applications/Cocos/Creator/3.8.3/CocosCreator.app/Contents',
    ];
    return candidates.find((candidate) => fs.existsSync(candidate));
}

/** 最小 asar 读取器：8 字节 size pickle + header pickle(JSON) + 数据区。 */
function openAsar(asarPath) {
    const fd = fs.openSync(asarPath, 'r');
    const sizeBuffer = Buffer.alloc(8);
    fs.readSync(fd, sizeBuffer, 0, 8, 0);
    const headerSize = sizeBuffer.readUInt32LE(4);
    const headerBuffer = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuffer, 0, headerSize, 8);
    const jsonLength = headerBuffer.readUInt32LE(4);
    const header = JSON.parse(headerBuffer.toString('utf8', 8, 8 + jsonLength));
    const dataOffset = 8 + headerSize;

    function findEntry(entryPath) {
        let node = header;
        for (const part of entryPath.split('/')) {
            if (!node || !node.files || !node.files[part]) return null;
            node = node.files[part];
        }
        return node;
    }

    return {
        has(entryPath) {
            return !!findEntry(entryPath);
        },
        read(entryPath) {
            const entry = findEntry(entryPath);
            if (!entry || entry.files) return null;
            if (entry.unpacked) return null;
            const buffer = Buffer.alloc(entry.size);
            if (entry.size > 0) fs.readSync(fd, buffer, 0, entry.size, dataOffset + Number(entry.offset));
            return buffer.toString('utf8');
        },
        close() {
            fs.closeSync(fd);
        },
    };
}

function checkAll(label, source, patterns) {
    if (source === null || source === undefined) {
        fail(`${label}: 读取失败`);
        return;
    }
    for (const pattern of patterns) {
        const hit = typeof pattern === 'string' ? source.includes(pattern) : pattern.test(source);
        check(hit, `${label}: ${typeof pattern === 'string' ? pattern : String(pattern)}`);
    }
}

function verifySceneTypes(asar) {
    console.log('\n--- scene 包内部 API（app.asar / @types）---');

    check(
        asar.has('builtin/scene/dist/script/3d/facade/general-scene-facade.ccc'),
        'require 目标存在: builtin/scene/dist/script/3d/facade/general-scene-facade',
    );
    check(
        asar.has('builtin/scene/dist/script/export/undo/scene.ccc'),
        'require 目标存在: builtin/scene/dist/script/export/undo/scene',
    );

    // fix1: SceneUndoManager / SceneUndoCommand
    checkAll('undo/scene.d.ts', asar.read('builtin/scene/@types/cce/export/undo/scene.d.ts'), [
        /_setUndo\(command: SceneUndoCommand, uuid: string\): void;/,
        /_setRedo\(command: SceneUndoCommand, uuid: string\): void;/,
        /beginRecording\(uuids: string \| string\[\], option\?: ISceneUndoOption\): SceneUndoCommandID;/,
        /endRecording\(id: SceneUndoCommandID\): boolean;/,
        /_autoCommands: SceneUndoCommand\[\];/,
        /_manualCommands: SceneUndoCommand\[\];/,
        /uuids: string\[\];/,
        /undoData: Map<string, IDump>;/,
        /redoData: Map<string, IDump>;/,
        /applyData\(data: Map<string, IDump>\): Promise<void>;/,
        /undo\(\): Promise<void>;/,
        /redo\(\): Promise<void>;/,
    ]);

    // fix1 + fix3: GeneralSceneFacade
    checkAll('general-scene-facade.d.ts', asar.read('builtin/scene/@types/cce/3d/facade/general-scene-facade.d.ts'), [
        /setNodeParent\(options: CutNodeOptions\): Promise<string\[\]>;/,
        /changeNodeLock\(uuids: string \| string\[\], locked: Boolean, loop: Boolean\): Promise<void>;/,
    ]);

    // fix1: set-parent payload 的 uuids 允许 string，normalizeUuids 因此必须兼容
    checkAll('public.d.ts (CutNodeOptions)', asar.read('builtin/scene/@types/public.d.ts'), [
        /export interface CutNodeOptions \{[\s\S]*?uuids: string \| string\[\];/,
    ]);

    // fix1 + fix3: cce.Node / cce.Scene
    checkAll('manager/node/index.d.ts', asar.read('builtin/scene/@types/cce/3d/manager/node/index.d.ts'), [
        /query\(uuid: string \| undefined\): Node \| null;/,
        /changeNodeLock\(uuids: string \| string\[\], locked: Boolean, loop: Boolean\): void;/,
    ]);
    checkAll('manager/scene/scene-manager.d.ts', asar.read('builtin/scene/@types/cce/3d/manager/scene/scene-manager.d.ts'), [
        /rootNode: Node \| null;/,
    ]);

    // fix3: change-node-lock 消息仍然由 scene 包提供
    const scenePackage = asar.read('builtin/scene/package.json');
    let messages = null;
    try {
        const parsed = JSON.parse(scenePackage);
        messages = (parsed.contributions && parsed.contributions.messages) || parsed.messages || null;
    } catch (_error) {
        messages = null;
    }
    check(!!(messages && messages['set-parent']), 'scene package.json: set-parent 消息存在');
    check(!!(messages && messages['change-node-lock']), 'scene package.json: change-node-lock 消息存在');
}

function verifyEditorVersion(asar) {
    console.log('\n--- 编辑器版本 ---');
    let version = '';
    try {
        version = JSON.parse(asar.read('package.json')).version || '';
    } catch (_error) {
        version = '';
    }
    check(version === EXPECTED_EDITOR_VERSION, `app.asar package.json version=${version || 'unknown'} 应为 ${EXPECTED_EDITOR_VERSION}`);
}

function verifyEngineSource(creatorRoot) {
    console.log('\n--- 引擎字段语义（明文 TS 源码）---');
    const engineRoot = path.join(creatorRoot, 'resources', 'resources', '3d', 'engine', 'cocos');

    function readEngine(relativePath) {
        const fullPath = path.join(engineRoot, relativePath);
        return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null;
    }

    // fix1: prefab override 结构与引擎自带的严格匹配 API
    checkAll('prefab/prefab-info.ts', readEngine('scene-graph/prefab/prefab-info.ts'), [
        /export class TargetInfo \{[\s\S]*?public localID: string\[\] = \[\];/,
        /export class PropertyOverrideInfo \{[\s\S]*?public propertyPath: string\[\] = \[\];[\s\S]*?public value: any;/,
        /public findPropertyOverride \(localID: string\[\], propPath: string\[\]\)/,
        /public propertyOverrides: PropertyOverrideInfo\[\] = \[\];/,
        /export class PrefabInstance \{[\s\S]*?public fileId = '';/,
        /export class PrefabInfo \{[\s\S]*?public fileId = '';/,
        /export class PrefabInfo \{[\s\S]*?public instance\?: PrefabInstance;/,
    ]);

    // fix1: 同步的 4 个 Transform 字段名
    checkAll('scene-graph/node.ts', readEngine('scene-graph/node.ts'), [
        /protected _lpos = new Vec3\(\);/,
        /protected _lrot = new Quat\(\);/,
        /protected _lscale = new Vec3\(1, 1, 1\);/,
        /protected _euler = new Vec3\(\);/,
    ]);

    // fix3: LockedInEditor 位值
    checkAll('core/data/object.ts', readEngine('core/data/object.ts'), [
        /const LockedInEditor = 1 << 9;/,
    ]);

    // fix2: Inspector contribution 原始泄漏点仍然存在（精确替换匹配数由另一个脚本校验）
    const contributions = path.join(creatorRoot, 'resources', 'resources', '3d', 'engine', 'editor', 'inspector', 'contributions');
    const assetSource = fs.existsSync(path.join(contributions, 'asset.js')) ? fs.readFileSync(path.join(contributions, 'asset.js'), 'utf8') : null;
    const nodeSource = fs.existsSync(path.join(contributions, 'node.js')) ? fs.readFileSync(path.join(contributions, 'node.js'), 'utf8') : null;
    if (assetSource === null || nodeSource === null) {
        fail('inspector contributions: asset.js / node.js 读取失败');
    } else {
        const assetAdd = (assetSource.match(/addBroadcastListener\('i18n:change'/g) || []).length;
        const assetRemove = (assetSource.match(/removeBroadcastListener\('i18n:change'/g) || []).length;
        check(assetAdd === 1 && assetRemove === 0, `asset.js 原始泄漏点成立 add=${assetAdd} remove=${assetRemove}（应为 1 / 0）`);
        check(nodeSource.includes('Elements.node.i18nChangeBind'), 'node.js 原始 bind 挂在模块级 Elements.node 上（多面板互相覆盖）');
    }
}

function verifyDistFreshness() {
    console.log('\n--- dist 与 source 一致性 ---');
    const expectations = [
        ['fixes/prefab-root-transform-override/index.js', 'override-recording-v6'],
        ['fixes/prefab-root-transform-override/index.js', 'normalizeUuids'],
        ['fixes/prefab-root-transform-override/index.js', 'findPropertyOverride'],
        ['fixes/prefab-child-lock-persistence/index.js', 'prefab-child-lock-persistence-v5'],
        ['fixes/prefab-child-lock-persistence/index.js', 'getChildFileIdPath'],
        ['main.js', 'uninstallEditorHooks'],
        ['editor-version.js', 'SUPPORTED_EDITOR_VERSION'],
        ['debug.js', 'warnOnce'],
    ];
    for (const [relativePath, needle] of expectations) {
        const fullPath = path.join(DIST_DIR, relativePath);
        if (!fs.existsSync(fullPath)) {
            fail(`dist/${relativePath} 不存在，请先执行 npm run build`);
            continue;
        }
        check(fs.readFileSync(fullPath, 'utf8').includes(needle), `dist/${relativePath} 含 ${needle}`);
    }
}

function main() {
    const creatorRoot = getCreatorRoot();
    if (!creatorRoot) {
        console.error('未找到 Cocos Creator 3.8.3，请设置 COCOS_CREATOR_383_PATH');
        process.exit(1);
    }
    console.log(`Creator root: ${creatorRoot}`);

    const asarPath = path.join(creatorRoot, 'resources', 'app.asar');
    if (!fs.existsSync(asarPath)) {
        console.error(`未找到 ${asarPath}`);
        process.exit(1);
    }

    const asar = openAsar(asarPath);
    try {
        verifyEditorVersion(asar);
        verifySceneTypes(asar);
    } finally {
        asar.close();
    }
    verifyEngineSource(creatorRoot);
    verifyDistFreshness();

    console.log('');
    if (failed > 0) {
        console.error(`Editor internals verification failed: ${failed} 项不通过`);
        process.exit(1);
    }
    console.log('Editor internals verification passed.');
}

main();
