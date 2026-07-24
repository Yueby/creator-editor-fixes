const fs = require('fs');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');

const assetReplacements = [
    {
        oldText: `            Elements.panel.i18nChangeBind = Elements.panel.i18nChange.bind(panel);
            Editor.Message.addBroadcastListener('i18n:change', Elements.panel.i18nChangeBind);`,
        newText: `            panel.i18nChangeBind = Elements.panel.i18nChange.bind(panel);
            Editor.Message.addBroadcastListener('i18n:change', panel.i18nChangeBind);`,
    },
    {
        oldText: `            Editor.Message.removeBroadcastListener('asset-db:asset-change', panel.__assetChanged__);

            delete panel.history;`,
        newText: `            Editor.Message.removeBroadcastListener('i18n:change', panel.i18nChangeBind);
            Editor.Message.removeBroadcastListener('asset-db:asset-change', panel.__assetChanged__);

            delete panel.history;`,
    },
];

const nodeReplacements = [
    {
        oldText: `            Elements.node.i18nChangeBind = Elements.node.i18nChange.bind(panel);
            Editor.Message.addBroadcastListener('i18n:change', Elements.node.i18nChangeBind);`,
        newText: `            panel.i18nChangeBind = Elements.node.i18nChange.bind(panel);
            Editor.Message.addBroadcastListener('i18n:change', panel.i18nChangeBind);`,
    },
    {
        oldText: `        close() {
            Editor.Message.removeBroadcastListener('i18n:change', Elements.node.i18nChangeBind);
        },`,
        newText: `        close() {
            const panel = this;

            Editor.Message.removeBroadcastListener('i18n:change', panel.i18nChangeBind);
        },`,
    },
];

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function getCreatorRoot() {
    if (process.env.COCOS_CREATOR_383_PATH) return process.env.COCOS_CREATOR_383_PATH;
    const candidates = [
        'C:\\ProgramData\\cocos\\editors\\Creator\\3.8.3',
        'C:\\Program Files\\Cocos\\Creator\\3.8.3',
        'D:\\ProgramData\\cocos\\editors\\Creator\\3.8.3',
        'E:\\ProgramData\\cocos\\editors\\Creator\\3.8.3',
    ];

    return candidates.find((candidate) => fs.existsSync(candidate));
}

function patchSource(source, replacements, label) {
    let patched = source;
    for (const replacement of replacements) {
        const oldText = source.includes('\r\n') ? replacement.oldText.replace(/\n/g, '\r\n') : replacement.oldText;
        const newText = source.includes('\r\n') ? replacement.newText.replace(/\n/g, '\r\n') : replacement.newText;
        const count = source.split(oldText).length - 1;
        assert(count === 1, `${label} 替换匹配次数应为 1，实际为 ${count}`);
        patched = patched.replace(oldText, newText);
    }

    return patched;
}

function verifyPatchFiles() {
    const creatorRoot = getCreatorRoot();
    assert(creatorRoot, '未找到 Cocos Creator 3.8.3，请设置 COCOS_CREATOR_383_PATH');

    const base = path.join(creatorRoot, 'resources', 'resources', '3d', 'engine', 'editor', 'inspector', 'contributions');
    const assetSource = fs.readFileSync(path.join(base, 'asset.js'), 'utf8');
    const nodeSource = fs.readFileSync(path.join(base, 'node.js'), 'utf8');
    const patchedAsset = patchSource(assetSource, assetReplacements, 'asset.js');
    const patchedNode = patchSource(nodeSource, nodeReplacements, 'node.js');

    assert(patchedAsset.includes("Editor.Message.addBroadcastListener('i18n:change', panel.i18nChangeBind);"), 'asset.js patched add missing');
    assert(patchedAsset.includes("Editor.Message.removeBroadcastListener('i18n:change', panel.i18nChangeBind);"), 'asset.js patched remove missing');
    assert(patchedNode.includes("Editor.Message.addBroadcastListener('i18n:change', panel.i18nChangeBind);"), 'node.js patched add missing');
    assert(patchedNode.includes("Editor.Message.removeBroadcastListener('i18n:change', panel.i18nChangeBind);"), 'node.js patched remove missing');
}

function verifyHook() {
    const hookPath = path.join(DIST_DIR, 'fixes', 'inspector-i18n-listener-leak', 'hook.js');
    delete require.cache[hookPath];
    const hook = require(hookPath);

    global.Editor = { App: { version: '3.8.3' } };
    const packageInfo383 = {};
    hook.register(packageInfo383);
    assert(packageInfo383.contributions.inspector.type.asset.endsWith(path.join('inspector-i18n-listener-leak', 'asset.js')), '3.8.3 asset wrapper 未注入');
    assert(packageInfo383.contributions.inspector.type.node.endsWith(path.join('inspector-i18n-listener-leak', 'node.js')), '3.8.3 node wrapper 未注入');

    global.Editor = { App: { version: '3.8.4' } };
    const packageInfo384 = {};
    hook.register(packageInfo384);
    assert(!packageInfo384.contributions, '3.8.4 不应注入 inspector wrapper');
    delete global.Editor;
}

function verifyRuntimePathResolution() {
    const creatorRoot = getCreatorRoot();
    assert(creatorRoot, '未找到 Cocos Creator 3.8.3，请设置 COCOS_CREATOR_383_PATH');

    const patcherPath = path.join(DIST_DIR, 'fixes', 'inspector-i18n-listener-leak', 'patcher.js');
    delete require.cache[patcherPath];
    global.Editor = { App: { path: path.join(creatorRoot, 'resources', 'app.asar') } };

    const patcher = require(patcherPath);
    const expected = path.join(creatorRoot, 'resources', 'resources', '3d', 'engine', 'editor', 'inspector', 'contributions', 'asset.js');
    assert(patcher.getOriginalContributionPath('asset.js') === expected, 'Editor.App.path=app.asar 时原始 contribution 路径解析错误');

    delete global.Editor;
}

verifyPatchFiles();
verifyHook();
verifyRuntimePathResolution();
console.log('Inspector i18n listener leak static verification passed.');
