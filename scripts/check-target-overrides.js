// 静态体检：场景/预制体里「指向 prefab 实例内部节点或组件」的引用（cc.TargetOverrideInfo）是否还能被引擎恢复。
//
// 判定完全按 Cocos Creator 3.8.3 引擎源码复刻（明文源码在 <Creator>/resources/resources/3d/engine/cocos）：
//   scene-graph/scene.ts        Scene._load          -> expandNestedPrefabInstanceNode(this) + applyTargetOverrides(this)
//   scene-graph/prefab/prefab.ts Prefab.onLoaded     -> expandNestedPrefabInstanceNode(data)  + applyTargetOverrides(data)
//   scene-graph/prefab/utils.ts applyTargetOverrides -> 5 处 continue + 1 处 return，全部静默丢弃引用
//   scene-graph/prefab/utils.ts generateTargetMap    -> 节点/组件 fileId 平铺，遇到非根的 prefab 实例才新开一层
//   scene-graph/prefab/utils.ts createNodeWithPrefab -> 实例子树由 asset 重新克隆，宿主文件里的子树会被覆盖
//   scene-graph/prefab/utils.ts applyMountedChildren -> mounted 节点再 generateTargetMap 进对应层
//   scene-graph/prefab/utils.ts getTarget            -> 用 localID 数组逐级索引 targetMap
//
// 三个容易踩错的细节，本工具都按引擎实际行为处理：
//   1. fileId 用 base64 字符集，**可能包含 '/'**（例如 baOm/vra5M6YKyFCmFkR84），不能用 '/' 拼路径；
//   2. 嵌套实例在宿主文件里是「未展开」的，内部节点是游离对象（_parent 指向实例根，但不在 _children 里），
//      targetMap 必须**跨资源递归**到被嵌套的那个 prefab 资源，且该层的 key 取 asset 根的 fileId；
//   3. 同一个对象从不同 target 视角看级数不同（场景里看外层实例是 2 级，prefab 内看内层实例是 1 级），
//      所以只有配合 target 节点才能判定 localID 是否正确。
//
// applyTargetOverrides 不递归子节点，只读「apply 根」自己的 prefab.targetOverrides。挂在 prefab 实例根节点上的
// targetOverrides 永远不会被读取（编辑器复制 prefab 资源记录时丢了 source/sourceInfo 的冗余数据），单列为 harmless。
//
// 用法：
//   node scripts/check-target-overrides.js <项目根>                 扫 assets 下所有 .scene 与 .prefab
//   node scripts/check-target-overrides.js <项目根> --scene         只扫 .scene
//   node scripts/check-target-overrides.js <某个.scene 或 .prefab>  只查单个文件
//   附加 --verbose 列出健康条目，--quiet 只输出有问题的文件
// 退出码：存在 BAD 条目时为 1，便于接入 CI。

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const inputs = args.filter((a) => !a.startsWith('--'));
const VERBOSE = flags.has('--verbose');
const QUIET = flags.has('--quiet');
const SCENE_ONLY = flags.has('--scene');

/** fileId 可能含 '/'，内部路径 key 用不可能出现在 base64 里的字符拼接。 */
const KEY_SEP = '\u0001';
const MAX_DEPTH = 24;

// ---------------------------------------------------------------- 压缩 uuid / cid

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Array(128).fill(64);
for (let i = 0; i < 64; i++) BASE64_VALUES[BASE64_KEYS.charCodeAt(i)] = i;
const HEX = '0123456789abcdef'.split('');

function expandBase64(text) {
    let hex = '';
    for (let i = 0; i + 1 < text.length; i += 2) {
        const lhs = BASE64_VALUES[text.charCodeAt(i)];
        const rhs = BASE64_VALUES[text.charCodeAt(i + 1)];
        if (lhs === 64 || rhs === 64) return null;
        hex += HEX[lhs >> 2] + HEX[((lhs & 3) << 2) | (rhs >> 4)] + HEX[rhs & 0xf];
    }
    return hex;
}

/** 脚本组件 __type__ 是压缩 uuid：22 位 = 2 hex + 20 base64，23 位 = 5 hex + 18 base64。 */
function decodeClassId(cid) {
    if (typeof cid !== 'string') return null;
    const plain = cid.split('@')[0];
    const prefixLength = plain.length === 22 ? 2 : plain.length === 23 ? 5 : 0;
    if (!prefixLength) return null;
    const tail = expandBase64(plain.slice(prefixLength));
    if (!tail) return null;
    const hex = plain.slice(0, prefixLength) + tail;
    if (hex.length !== 32) return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------- 文件遍历与资源索引

function walkFiles(dir, onFile, depth = 0) {
    if (depth > 12) return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!/^(node_modules|\.git|library|temp|build|profiles)$/i.test(entry.name)) walkFiles(full, onFile, depth + 1);
        } else if (entry.isFile()) {
            onFile(full, entry.name);
        }
    }
}

function findProjectRoot(start) {
    let current = path.resolve(start);
    if (fs.statSync(current).isFile()) current = path.dirname(current);
    for (let i = 0; i < 12; i++) {
        if (fs.existsSync(path.join(current, 'assets'))) return current;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

// ---------------------------------------------------------------- 序列化文档

class Doc {
    constructor(filePath, data) {
        this.filePath = filePath;
        this.data = data;
    }

    static load(filePath) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(data)) throw new Error('不是数组形式的序列化文件');
        return new Doc(filePath, data);
    }

    at(index) {
        return typeof index === 'number' ? this.data[index] : undefined;
    }

    deref(ref) {
        if (ref && typeof ref === 'object' && typeof ref.__id__ === 'number') return this.data[ref.__id__];
        return ref === undefined ? undefined : ref;
    }

    refIndex(ref) {
        return ref && typeof ref === 'object' && typeof ref.__id__ === 'number' ? ref.__id__ : null;
    }

    prefabInfoOf(node) {
        return node ? this.deref(node._prefab) : undefined;
    }

    /** 组件 -> 所在节点；节点 -> 自己。 */
    nodeOf(obj) {
        if (!obj) return null;
        if (obj.__type__ === 'cc.Node' || obj.__type__ === 'cc.Scene' || Array.isArray(obj._children)) return obj;
        return this.deref(obj.node) || null;
    }

    nodePath(obj) {
        const names = [];
        let current = this.nodeOf(obj);
        for (let i = 0; i < 64 && current; i++) {
            names.unshift(current._name || '(unnamed)');
            current = this.deref(current._parent);
        }
        return names.join('/');
    }

    /** cc.Prefab.data 指向的根节点；场景文件返回 cc.Scene。 */
    rootNodeIndex() {
        const prefab = this.data.find((o) => o && o.__type__ === 'cc.Prefab');
        if (prefab) return this.refIndex(prefab.data);
        const sceneIndex = this.data.findIndex((o) => o && o.__type__ === 'cc.Scene');
        return sceneIndex >= 0 ? sceneIndex : null;
    }
}

// ---------------------------------------------------------------- 资源解析（含 fbx 内嵌 prefab）

class AssetResolver {
    constructor(projectRoot) {
        this.projectRoot = projectRoot;
        this.byUuid = new Map();
        this.scriptByUuid = new Map();
        this.docCache = new Map();
        this.mapCache = new Map();
        walkFiles(path.join(projectRoot, 'assets'), (full, name) => {
            if (!name.endsWith('.meta')) return;
            const assetPath = full.replace(/\.meta$/, '');
            let meta;
            try {
                meta = JSON.parse(fs.readFileSync(full, 'utf8'));
            } catch (_error) {
                return;
            }
            if (meta.uuid) {
                if (/\.(prefab|scene)$/.test(assetPath)) this.byUuid.set(meta.uuid, assetPath);
                else if (/\.(ts|js)$/.test(assetPath)) this.scriptByUuid.set(meta.uuid, assetPath);
            }
            // fbx/gltf 的内嵌 prefab 是 sub-asset，磁盘上没有 .prefab 文件，只能读 library 导入产物
            for (const sub of Object.values(meta.subMetas || {})) {
                if (sub && sub.uuid && /gltf-scene|gltf-prefab|prefab/i.test(String(sub.importer || ''))) {
                    this.byUuid.set(sub.uuid, null);
                }
            }
        });
    }

    /** uuid -> 可读名字，用于报告。 */
    displayName(uuid) {
        const assetPath = this.byUuid.get(uuid);
        if (assetPath) return path.basename(assetPath);
        const libraryPath = this.libraryPath(uuid);
        return libraryPath ? `${uuid.split('@')[0].slice(0, 8)}…@${uuid.split('@')[1] || ''}(library)` : uuid.slice(0, 8);
    }

    libraryPath(uuid) {
        const file = path.join(this.projectRoot, 'library', uuid.slice(0, 2), `${uuid}.json`);
        return fs.existsSync(file) ? file : null;
    }

    /** 优先读 assets 里的源文件，其次读 library 导入产物（fbx 内嵌 prefab）。 */
    loadDoc(uuid) {
        if (this.docCache.has(uuid)) return this.docCache.get(uuid);
        let result = null;
        const assetPath = this.byUuid.get(uuid) || null;
        const file = assetPath || this.libraryPath(uuid);
        if (!file) {
            result = { error: '资源文件与 library 导入产物都不存在' };
        } else {
            try {
                result = { doc: Doc.load(file), file };
            } catch (error) {
                result = { error: `${path.basename(file)}: ${error.message}` };
            }
        }
        this.docCache.set(uuid, result);
        return result;
    }

    /** 以资源根节点为 isRoot=true 构建 targetMap，与运行时实例展开后的形态一致。 */
    targetMapOf(uuid) {
        if (this.mapCache.has(uuid)) return this.mapCache.get(uuid);
        const loaded = this.loadDoc(uuid);
        let result;
        if (loaded.error) {
            result = { error: loaded.error };
        } else {
            const rootIndex = loaded.doc.rootNodeIndex();
            if (rootIndex == null) result = { error: '找不到资源根节点' };
            else {
                const out = { strict: new Map(), flat: new Map(), approximate: false };
                visitForTargetMap(loaded.doc, rootIndex, [], true, out, this, 0);
                result = out;
            }
        }
        this.mapCache.set(uuid, result);
        return result;
    }
}

function putTarget(out, keys, fileId, info) {
    if (!fileId) return;
    const full = keys.concat(fileId);
    const key = full.join(KEY_SEP);
    if (!out.strict.has(key)) out.strict.set(key, info);
    if (!out.flat.has(fileId)) out.flat.set(fileId, []);
    out.flat.get(fileId).push({ ...info, keys: full });
}

/** 复刻 generateTargetMap + createNodeWithPrefab + applyMountedChildren 的联合行为。 */
function visitForTargetMap(doc, nodeIndex, keys, isRoot, out, resolver, depth) {
    if (depth > MAX_DEPTH) return;
    const node = doc.at(nodeIndex);
    if (!node) return;

    const prefabInfo = doc.prefabInfoOf(node);
    const instance = prefabInfo ? doc.deref(prefabInfo.instance) : undefined;
    // 非根的 prefab 实例会在 targetMap 里新开一层，键是 PrefabInstance.fileId
    const currentKeys = !isRoot && instance && instance.fileId ? keys.concat(instance.fileId) : keys;

    const assetUuid = instance && prefabInfo && prefabInfo.asset ? prefabInfo.asset.__uuid__ : null;
    const nested = assetUuid ? resolver.targetMapOf(assetUuid) : null;

    if (nested && !nested.error) {
        // 运行时该节点子树由 asset 重新克隆，节点自身的 prefab 也被换成 asset 根的 PrefabInfo，
        // 所以这一层的内容整体来自被嵌套资源，而不是宿主文件里的游离子树。
        for (const [key, info] of nested.strict) {
            const full = currentKeys.concat(key.split(KEY_SEP));
            const joined = full.join(KEY_SEP);
            if (!out.strict.has(joined)) out.strict.set(joined, info);
            const last = full[full.length - 1];
            if (!out.flat.has(last)) out.flat.set(last, []);
            out.flat.get(last).push({ ...info, keys: full });
        }
        if (nested.approximate) out.approximate = true;
    } else {
        if (nested && nested.error) out.approximate = true;
        if (prefabInfo) putTarget(out, currentKeys, prefabInfo.fileId, { kind: 'node', name: node._name || '(unnamed)' });
        for (const ref of node._components || []) {
            const comp = doc.deref(ref);
            const compInfo = comp ? doc.deref(comp.__prefab) : null;
            if (!compInfo) continue;
            putTarget(out, currentKeys, compInfo.fileId, {
                kind: 'component',
                name: comp.__type__,
                nodeName: node._name || '(unnamed)',
            });
        }
        for (const ref of node._children || []) {
            const childIndex = doc.refIndex(ref);
            if (childIndex != null) visitForTargetMap(doc, childIndex, currentKeys, false, out, resolver, depth + 1);
        }
    }

    // 实例里新增的节点：引擎会 generateTargetMap 到 localID 前缀所在的那一层
    for (const ref of (instance && instance.mountedChildren) || []) {
        const mounted = doc.deref(ref);
        const info = mounted ? doc.deref(mounted.targetInfo) : null;
        const localID = info && Array.isArray(info.localID) ? info.localID : [];
        const base = currentKeys.concat(localID.slice(0, Math.max(0, localID.length - 1)));
        for (const nodeRef of (mounted && mounted.nodes) || []) {
            const mountedIndex = doc.refIndex(nodeRef);
            if (mountedIndex != null) visitForTargetMap(doc, mountedIndex, base, false, out, resolver, depth + 1);
        }
    }
    // 实例里新增的组件：applyMountedComponents 只 push 到 target.components，不写进 targetMap
    for (const ref of (instance && instance.mountedComponents) || []) {
        const mounted = doc.deref(ref);
        for (const compRef of (mounted && mounted.components) || []) {
            const comp = doc.deref(compRef);
            const compInfo = comp ? doc.deref(comp.__prefab) : null;
            if (compInfo && compInfo.fileId) {
                if (!out.mountedComponentIds) out.mountedComponentIds = new Set();
                out.mountedComponentIds.add(compInfo.fileId);
            }
        }
    }
}

// ---------------------------------------------------------------- 单条判定

const OK = 'OK';
const WARN = 'WARN';
const BAD = 'BAD';

function describeHolder(doc, index, resolver) {
    const obj = doc.at(index);
    if (!obj) return `@${index}`;
    const scriptUuid = decodeClassId(obj.__type__);
    const scriptPath = scriptUuid && resolver.scriptByUuid.get(scriptUuid);
    const typeName = scriptPath ? path.basename(scriptPath) : obj.__type__;
    return `${doc.nodePath(obj)} [${typeName}]`;
}

/** 在 target 实例对应的资源里解析 localID。 */
function resolveLocalId(doc, resolver, instanceNode, localID, side) {
    const prefabInfo = doc.prefabInfoOf(instanceNode);
    const assetUuid = prefabInfo && prefabInfo.asset && prefabInfo.asset.__uuid__;
    if (!assetUuid) return { status: BAD, reason: `${side} 实例节点没有 prefab 资源引用` };

    const map = resolver.targetMapOf(assetUuid);
    const assetName = resolver.displayName(assetUuid);
    if (map.error) return { status: WARN, reason: `${side} 目标资源无法解析（${assetName}: ${map.error}）` };

    const hit = map.strict.get(localID.join(KEY_SEP));
    if (hit) {
        const where = hit.kind === 'component' ? `${hit.nodeName}/${hit.name}` : hit.name;
        return { status: OK, detail: `${assetName} -> ${hit.kind} ${where}` };
    }

    const last = localID[localID.length - 1];
    const flatHits = map.flat.get(last);
    if (flatHits && flatHits.length) {
        const alt = flatHits[0];
        const where = alt.kind === 'component' ? `${alt.nodeName}/${alt.name}` : alt.name;
        return {
            status: BAD,
            reason: `${side} localID 层级不符：记录为 ${JSON.stringify(localID)}，${assetName} 里该 fileId 实际在 ${JSON.stringify(alt.keys)}（${where}）`,
        };
    }

    if (map.mountedComponentIds && map.mountedComponentIds.has(last)) {
        return { status: WARN, reason: `${side} localID 指向实例内挂载的组件，引擎不会把它写进 targetMap，需人工确认（${assetName}）` };
    }
    if (map.approximate) {
        return { status: WARN, reason: `${side} localID ${JSON.stringify(localID)} 在 ${assetName} 里找不到，但该资源有子资源解析失败，结论不确定` };
    }
    return { status: BAD, reason: `${side} localID ${JSON.stringify(localID)} 在 ${assetName} 里不存在（断链）` };
}

function checkOverride(doc, resolver, entryIndex, nestedRoots) {
    const entry = doc.at(entryIndex);
    const propertyPath = Array.isArray(entry.propertyPath) ? entry.propertyPath : [];
    const pathText = propertyPath.join('.') || '(空)';
    const sourceIndex = doc.refIndex(entry.source);
    const where = sourceIndex != null ? describeHolder(doc, sourceIndex, resolver) : '(source 未知)';
    const fail = (reason) => ({ status: BAD, pathText, where, reason });

    if (propertyPath.length === 0) return fail('propertyPath 为空');
    if (!propertyPath[propertyPath.length - 1]) {
        return fail('propertyPath 末段为空 —— 引擎在这里是 return，同一 apply 根后续所有引用会一起失效');
    }

    // source 侧：sourceInfo 存在时 source 必须是 prefab 实例根，再用 localID 在其资源里解析
    const sourceInfo = doc.deref(entry.sourceInfo);
    if (!sourceInfo) {
        if (entry.source == null) return fail('source 与 sourceInfo 均为 null，引擎第一个 continue 必然跳过');
    } else {
        const sourceNode = doc.nodeOf(doc.at(sourceIndex));
        const sourcePrefab = sourceNode ? doc.prefabInfoOf(sourceNode) : null;
        if (!sourcePrefab || !doc.deref(sourcePrefab.instance)) {
            return fail('sourceInfo 存在但 source 不是 prefab 实例根节点，运行时解析不出 source');
        }
        if (!Array.isArray(sourceInfo.localID) || sourceInfo.localID.length === 0) return fail('sourceInfo.localID 为空');
        const resolvedSource = resolveLocalId(doc, resolver, sourceNode, sourceInfo.localID, 'source');
        if (resolvedSource.status !== OK) return { status: resolvedSource.status, pathText, where, reason: resolvedSource.reason };
    }

    // target 侧
    const targetInfo = doc.deref(entry.targetInfo);
    if (!targetInfo || !Array.isArray(targetInfo.localID) || targetInfo.localID.length === 0) return fail('targetInfo/localID 缺失');
    const targetIndex = doc.refIndex(entry.target);
    const targetNode = targetIndex != null ? doc.at(targetIndex) : null;
    if (!targetNode) return fail('target 为 null（常见于复制粘贴节点后保存）');
    const targetPrefab = doc.prefabInfoOf(targetNode);
    if (!targetPrefab || !doc.deref(targetPrefab.instance)) return fail('target 不是 prefab 实例根节点，运行时没有 targetMap');
    if (nestedRoots && !nestedRoots.has(targetIndex)) {
        return fail('target 不在 apply 根的 nestedPrefabInstanceRoots 里，运行时不会展开该实例，targetMap 不存在');
    }

    const resolved = resolveLocalId(doc, resolver, targetNode, targetInfo.localID, 'target');
    return { status: resolved.status, pathText, where, reason: resolved.reason, detail: resolved.detail };
}

// ---------------------------------------------------------------- 文件级

function findApplyRoot(doc) {
    const scene = doc.data.find((o) => o && o.__type__ === 'cc.Scene');
    if (scene) return doc.prefabInfoOf(scene);
    const rootIndex = doc.rootNodeIndex();
    const root = rootIndex != null ? doc.at(rootIndex) : null;
    return root ? doc.prefabInfoOf(root) : null;
}

function checkFile(filePath, resolver, report) {
    let doc;
    try {
        doc = Doc.load(filePath);
    } catch (error) {
        report.errors.push(`${path.relative(resolver.projectRoot, filePath)}: ${error.message}`);
        return;
    }

    const entries = [];
    doc.data.forEach((o, i) => {
        if (o && o.__type__ === 'cc.TargetOverrideInfo') entries.push(i);
    });
    if (entries.length === 0) return;

    const applyInfo = findApplyRoot(doc);
    const applyEntries = new Set();
    let nestedRoots = null;
    if (applyInfo) {
        for (const ref of applyInfo.targetOverrides || []) {
            const index = doc.refIndex(ref);
            if (index != null) applyEntries.add(index);
        }
        nestedRoots = new Set((applyInfo.nestedPrefabInstanceRoots || []).map((ref) => doc.refIndex(ref)).filter((v) => v != null));
    }

    const stat = { ok: 0, bad: 0, warn: 0, harmless: 0 };
    const lines = [];
    for (const index of entries) {
        if (!applyEntries.has(index)) {
            stat.harmless++;
            continue;
        }
        const result = checkOverride(doc, resolver, index, nestedRoots);
        if (result.status === OK) {
            stat.ok++;
            if (VERBOSE) lines.push(`  ok   @${index} ${result.where}.${result.pathText}  ->  ${result.detail}`);
        } else if (result.status === WARN) {
            stat.warn++;
            lines.push(`  WARN @${index} ${result.where}.${result.pathText}\n       ${result.reason}`);
        } else {
            stat.bad++;
            lines.push(`  BAD  @${index} ${result.where}.${result.pathText}\n       ${result.reason}`);
        }
    }

    report.files++;
    report.ok += stat.ok;
    report.bad += stat.bad;
    report.warn += stat.warn;
    report.harmless += stat.harmless;
    const rel = path.relative(resolver.projectRoot, filePath) || filePath;
    if (stat.bad > 0) report.badFiles.push(rel);
    if (QUIET && stat.bad === 0 && stat.warn === 0) return;

    const summary = [`apply 根 ${stat.ok + stat.bad + stat.warn} 条: ok ${stat.ok}`];
    if (stat.bad) summary.push(`BAD ${stat.bad}`);
    if (stat.warn) summary.push(`WARN ${stat.warn}`);
    if (stat.harmless) summary.push(`| 实例根 ${stat.harmless} 条: 无害脏数据（引擎不读取）`);
    console.log(`\n${rel}\n  ${summary.join('  ')}`);
    lines.forEach((line) => console.log(line));
}

// ---------------------------------------------------------------- main

function main() {
    if (inputs.length === 0) {
        console.error('用法: node scripts/check-target-overrides.js <项目根 | .scene | .prefab> [--scene] [--verbose] [--quiet]');
        process.exit(2);
    }
    const first = path.resolve(inputs[0]);
    if (!fs.existsSync(first)) {
        console.error(`路径不存在: ${first}`);
        process.exit(2);
    }
    const projectRoot = findProjectRoot(first);
    if (!projectRoot) {
        console.error(`找不到 Cocos 项目根（含 assets 目录）: ${first}`);
        process.exit(2);
    }

    const resolver = new AssetResolver(projectRoot);
    const targets = [];
    for (const input of inputs) {
        const full = path.resolve(input);
        if (fs.statSync(full).isFile()) targets.push(full);
        else {
            walkFiles(full, (file, name) => {
                if (name.endsWith('.scene') || (!SCENE_ONLY && name.endsWith('.prefab'))) targets.push(file);
            });
        }
    }

    console.log(`项目: ${projectRoot}`);
    console.log(`prefab/scene 索引 ${resolver.byUuid.size}，脚本索引 ${resolver.scriptByUuid.size}，待检查文件 ${targets.length}`);

    const report = { files: 0, ok: 0, bad: 0, warn: 0, harmless: 0, badFiles: [], errors: [] };
    for (const file of targets) checkFile(file, resolver, report);

    console.log('\n================ 汇总 ================');
    console.log(`含 targetOverrides 的文件: ${report.files}`);
    console.log(`会被引擎读取的条目: ok ${report.ok}  BAD ${report.bad}  WARN ${report.warn}`);
    console.log(`prefab 实例根上的无害脏数据: ${report.harmless}`);
    if (report.badFiles.length) console.log(`有 BAD 的文件:\n  ${report.badFiles.join('\n  ')}`);
    if (report.errors.length) console.log(`解析失败:\n  ${report.errors.join('\n  ')}`);
    process.exit(report.bad > 0 ? 1 : 0);
}

main();
