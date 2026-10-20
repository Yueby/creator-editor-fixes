# Creator Editor Fixes

用于集中维护 **Cocos Creator 3.8.3** 编辑器侧修复的扩展插件。

当前包含的修复模块：

```text
prefab-root-transform-override
prefab-child-lock-persistence
prefab-active-override-sync
inspector-i18n-listener-leak
```

该模块修复 prefab 实例根节点在编辑器内调整父节点后，Transform override 保存、切换场景、撤销/重做状态不一致的问题。

`prefab-child-lock-persistence` 让 prefab 实例内子节点的编辑器锁定状态（`LockedInEditor`）可以跨场景重载、跨编辑器重启保留，因为 Creator 原生不会把它序列化进场景。

`prefab-active-override-sync` 修复用快捷键（`toggle-active-selected-node`）取消激活 prefab 实例内节点后，`active` 没有写入 `propertyOverrides`、保存后切换场景又恢复激活的问题。Inspector 勾选框走的是另一条路径，本来就正常。

`inspector-i18n-listener-leak` 修复 Cocos Creator 3.8.3 Inspector 面板切换时 `i18n:change` 广播监听未随面板释放的问题，尤其可降低多材质 MeshRenderer 等 Inspector 反复打开后的内存增长。

## 问题背景

在 Cocos Creator 3.8.3 中，将 prefab 实例根节点拖入或拖出带有非默认 Transform 的父节点时，编辑器中的实时位置看起来可能是正确的，但保存到场景文件的 prefab 根节点 Transform override 可能没有同步到正确值。

常见表现：

- 当前场景里看起来正常，切换场景后 prefab 位置错位。
- 撤销或重做后，父子关系恢复了，但 prefab 根节点 Transform override 没有正确恢复。
- 多次移入/移出父节点后，位置会累积偏移。

根因分两层：

1. prefab 实例根节点的本地 Transform 不是直接存节点，而是通过 `PrefabInstance.propertyOverrides` 序列化进场景文件。reparent 只更新了内存里的实时 `node._lpos` 等（视图正确），却没有把新值同步回对应的 override 条目，所以保存时写进 `.scene` 的是旧值，切换场景/重载后错位、多次操作累积偏移。
2. Creator 原始 `set-parent` undo command 没有包含 prefab 根节点 child，导致撤销/重做无法恢复它的 Transform / override 状态。

详细根因与修复步骤见 `source/fixes/prefab-root-transform-override/README.md`。

## 当前修复方案

`prefab-root-transform-override` 采用 **编辑器 scene 进程运行时 hook** 的方式修复问题，不修改 Creator 安装包，也不修改项目场景文件格式。

核心思路：

1. 在 Creator 原始 `set-parent` recording 中补入 prefab 根节点 child。
2. 使用 Creator 原始 `_setUndo` 捕获 reparent 前状态。
3. 在原始 `endRecording` 后，同步 prefab 根节点已有的 Transform override。
4. 使用 Creator 原始 `_setRedo` 将同步后的状态纳入同一个 undo/redo command。
5. 在 `applyData` 时使用 child-first 顺序，避免撤销/重做时出现可见闪动。

当前主方案版本：

```text
override-recording-v6
```

prefab 根节点 override 条目的定位使用引擎自带的 EDITOR-only API `PrefabInstance.findPropertyOverride([fileId], [transformKey])`，语义与序列化端的 `compareStringArray` 一致；该 API 不可用时回退到等价的严格数组比较，不做 `includes` 宽松匹配，避免命中嵌套 prefab 的多级 `localID` 或 `['_lpos','x']` 这类分量级 override。

Inspector i18n 监听泄漏修复使用 `creator.hookScript` 仅在 `Editor.App.version === '3.8.3'` 时动态注入：

```text
contributions.inspector.type.asset -> dist/fixes/inspector-i18n-listener-leak/asset.js
contributions.inspector.type.node  -> dist/fixes/inspector-i18n-listener-leak/node.js
```

包装模块会从当前 Creator 安装目录读取原始 3.8.3 Inspector contribution 文件，在内存中精确替换并编译，不修改 Creator 安装包，也不覆盖 `require.cache`。如果原始代码匹配次数不是 1，会关闭补丁并回退加载原始文件。

扩展版本：

```text
1.0.15
```

scene 进程的三个 hook 模块（`prefab-root-transform-override`、`prefab-child-lock-persistence`、`prefab-active-override-sync`）只在 `Editor.App.version === '3.8.3'` 时安装；其它版本会输出一次 warning 后跳过，不会把 patch 打在未验证过的内部实现上。

## 使用到的编辑器内部 hook

插件运行在 Creator 的 scene 进程中，会在运行时 hook 以下编辑器内部方法：

```text
GeneralSceneFacade.prototype.setNodeParent
GeneralSceneFacade.prototype.changeNodeLock
SceneUndoManager.prototype.beginRecording
SceneUndoManager.prototype.endRecording
SceneUndoCommand.prototype.applyData
SceneUndoCommand.prototype.undo
SceneUndoCommand.prototype.redo
```

这些 hook 只在编辑器内生效，不影响游戏运行时。扩展被禁用或卸载时，`main.ts` 会通过 scene 脚本调用 `uninstallEditorHooks`，把上面所有方法还原，不留残留 wrapper。

## 安全边界

当前修复避免使用以下高风险方式：

- 不修改 Creator 安装目录。
- 不创建独立 undo 记录。
- 不调用 `scene:set-property`。
- 不调用 `cce.Node.setProperty`。
- 不调用 `scene:snapshot`。
- 不使用延迟定时器修补 Transform。
- 不直接写入 scene/prefab 文件。
- 不新增 prefab override 条目。
- 不在非 3.8.3 的编辑器上安装任何 scene hook。
- Inspector 修复不贡献 header/section/footer，仅覆盖 `type.asset` 与 `type.node`。

已知限制：Inspector 修复通过 `contributions.inspector.type.asset` / `type.node` 生效，与其它同样覆盖这两个 key 的扩展互斥（后加载者生效）。

插件只会在原始 set-parent recording 内，更新 prefab 根节点已经存在的 Transform override 条目：

```text
_lpos
_lrot
_euler
_lscale
```

并在更新后立即调用原始 `_setRedo`，确保变更进入同一个原始 undo/redo command。如果 `_setRedo` 失败，会回滚本次替换。

## 项目结构

```text
creator-editor-fixes/
├─ source/
│  ├─ main.ts                                # 编辑器主进程入口，负责安装/卸载 scene hook
│  ├─ scene.ts                               # scene 进程入口，委托到修复模块
│  ├─ debug.ts                               # Debug 日志开关 + 关键失败 warnOnce
│  ├─ editor-version.ts                      # 统一的 3.8.3 版本守卫
│  └─ fixes/
│     ├─ prefab-root-transform-override/     # override-recording-v6 修复
│     │  ├─ index.ts
│     │  └─ README.md                        # override-recording-v6 修复原理
│     ├─ prefab-child-lock-persistence/      # prefab 子节点锁定持久化
│     │  ├─ index.ts
│     │  └─ README.md                        # 持久化方案与限制
│     ├─ prefab-active-override-sync/        # 快捷键取消激活的 active override 同步
│     │  ├─ index.ts
│     │  └─ README.md                        # 根因与修复原理
│     └─ inspector-i18n-listener-leak/       # Inspector i18n 监听泄漏修复
│        ├─ hook.ts
│        ├─ patcher.ts
│        ├─ asset.ts
│        ├─ node.ts
│        └─ README.md                        # Inspector 修复原理
├─ scripts/
│  ├─ clean-dist.js
│  ├─ package-dist.js
│  ├─ check-target-overrides.js              # 项目体检：prefab 跨节点引用（targetOverrides）是否断链
│  ├─ verify-scene-fixes.js                  # scene hook 离线冒烟测试（不需要 Creator）
│  ├─ verify-inspector-i18n-listener-leak.js # Inspector 精确替换静态校验
│  └─ verify-editor-internals.js             # 校验 hook 依赖的编辑器内部 API 是否仍成立
├─ dist/
│  ├─ main.js
│  ├─ scene.js
│  ├─ debug.js
│  ├─ editor-version.js
│  ├─ fixes/
│  │  ├─ prefab-root-transform-override/index.js
│  │  ├─ prefab-child-lock-persistence/index.js
│  │  ├─ prefab-active-override-sync/index.js
│  │  └─ inspector-i18n-listener-leak/
│  │     ├─ hook.js
│  │     ├─ patcher.js
│  │     ├─ asset.js
│  │     └─ node.js
│  ├─ package.json
│  └─ creator-editor-fixes-1.0.15.zip
├─ package.json
├─ package-lock.json
└─ tsconfig.json
```

## Fix 文档约定

每个 `source/fixes/` 下的修复模块都必须在源码旁维护修复原理文档。

文档至少说明：

- 修复目标和用户可见问题。
- 根因分析。
- 为什么当前 patch 能解决问题。
- Hook / backport / 替换的范围。
- 安全边界和不采用的方案。
- 静态验证与运行时验证方式。

当前文档：

```text
source/fixes/prefab-root-transform-override/README.md
source/fixes/prefab-child-lock-persistence/README.md
source/fixes/prefab-active-override-sync/README.md
source/fixes/inspector-i18n-listener-leak/README.md
```

## 构建

首次构建前安装依赖：

```bash
npm install
```

执行构建：

```bash
npm run build
```

构建会执行：

1. 清理 `dist/`。
2. TypeScript 编译（去注释、不带 sourcemap）。
3. 生成发布用 `dist/package.json`。
4. 生成 deflate 压缩的 zip 包，并逐条解压比对 CRC 与字节自检。

需要跟 dist 产物断点调试时用带 sourcemap 的构建（体积约 3.5 倍）：

```bash
npm run build:debug   # tsc -p tsconfig.debug.json
npm run watch         # 监听模式同样用 tsconfig.debug.json
```

两种构建的体积对比：

| 构建 | dist 内 js 合计 | zip |
| --- | --- | --- |
| `npm run build`（发布） | 约 58 KB | 约 17 KB |
| `npm run build:debug`（排查） | 约 209 KB | 约 66 KB |

构建产物：

```text
dist/creator-editor-fixes-1.0.15.zip
```

zip 内包含：

```text
main.js
scene.js
debug.js
editor-version.js
fixes/prefab-root-transform-override/index.js
fixes/prefab-child-lock-persistence/index.js
fixes/prefab-active-override-sync/index.js
fixes/inspector-i18n-listener-leak/hook.js
fixes/inspector-i18n-listener-leak/patcher.js
fixes/inspector-i18n-listener-leak/asset.js
fixes/inspector-i18n-listener-leak/node.js
package.json
```

## Debug 日志开关

默认不输出修复命中、校验、uuid 列表等调试日志，避免影响编辑器控制台性能。

如需排查问题，可修改 `source/debug.ts` 里的 `export const DEBUG = false;` 为 `true`，然后重新构建（排查场景建议用带 sourcemap 的那个）：

```bash
npm run build:debug
```

也可以在对应进程中临时设置全局标记（scene 进程的日志需要在场景调试窗口里设）：

```js
globalThis.__creatorEditorFixesDebug__ = true;
```

与普通调试日志不同，以下关键失败不受 DEBUG 开关控制，会用 `console.warn` 输出一次（同一原因不重复刷屏）：

```text
编辑器版本不是 3.8.3，跳过安装
未找到 scene 包路径 / 内部实现（GeneralSceneFacade、SceneUndoManager、SceneUndoCommand）
部分 hook 未安装（installed=n/6）
未找到 _setUndo / _setRedo
未能 hook changeNodeLock
Inspector 精确替换匹配次数异常、内存补丁加载失败
undo/redo 超时未结束，applying 计数已兜底恢复
```

看到这些 warning 就意味着对应修复没生效，而不是静默失败。

## 导入编辑器

在 Cocos Creator 扩展管理器中导入：

```text
dist/creator-editor-fixes-1.0.15.zip
```

导入后重启或重载扩展，使 scene hook 生效。

## 验证方式

### 一次跑完所有自动校验

```bash
npm run build
npm run verify
```

如本机 Creator 3.8.3 不在默认位置，先设置（Windows cmd 用 `set`，bash 用 `export`）：

```bash
export COCOS_CREATOR_383_PATH=/c/ProgramData/cocos/editors/Creator/3.8.3
```

`npm run verify` 依次执行三个脚本：

| 脚本 | 验证内容 | 是否需要安装 Creator |
| --- | --- | --- |
| `scripts/verify-scene-fixes.js` | 用假的 `SceneUndoManager` / `SceneUndoCommand` / `GeneralSceneFacade` / `cce` 真跑 dist：uuids 传 string、override 严格匹配、干扰条目不被误伤、redoData 同步、child-first 顺序、endRecording 收到无关 id、锁定 key 路径化与 v4 旧数据兼容、restore 不回写、uninstall 还原、版本守卫 | 不需要 |
| `scripts/verify-inspector-i18n-listener-leak.js` | Inspector 四处精确替换在 3.8.3 原文中各匹配 1 次、hookScript 注入与版本守卫、`Editor.App.path=app.asar` 时的路径推导 | 需要 |
| `scripts/verify-editor-internals.js` | 解包 `app.asar`，校验 hook 依赖的内部签名（`_setUndo`/`_setRedo`/`applyData`/`setNodeParent`/`changeNodeLock`/`cce.Node.query`/`rootNode`）、`CutNodeOptions.uuids: string \| string[]`、引擎字段（`localID: string[]`、`propertyPath: string[]`、`findPropertyOverride`、`_lpos/_lrot/_euler/_lscale`、`LockedInEditor = 1 << 9`）、Inspector 原始泄漏点仍成立、dist 已按当前 source 重新构建 | 需要 |

升级 Creator 后只要跑 `npm run verify`，就能知道哪一条内部假设失效了，不用先手工试。

### prefab 根节点 Transform override

建议使用一个带非默认 Transform 的父节点 `Parent` 测试：

1. 将 prefab 实例根节点拖入 `Parent`。
2. 保存并切换场景，确认位置不变。
3. 将 prefab 实例根节点拖出 `Parent`。
4. 保存并切换场景，确认位置不变。
5. 测试 Ctrl+Z / Ctrl+Y，确认父子关系与位置都正确。
6. 多选多个 prefab 实例根节点重复上述操作。

### prefab 子节点锁定持久化

1. 锁定 prefab 实例内的一个子节点，切换场景再切回，确认仍然锁定。
2. 单独解锁该子节点，重载后确认仍然解锁。
3. 嵌套 prefab：同一个外层实例里放两份相同的嵌套 prefab，只锁其中一份的子节点，确认另一份不跟着变。
4. 锁定顶层 prefab 根节点，确认不写入项目 Profile（该状态由 Creator 原生序列化）。

### 日志确认

打开 debug 后，日志中应能看到类似信息：

```text
[creator-editor-fixes][override-recording-v6] 已安装 override recording 最小修复
[creator-editor-fixes][override-recording-v6] 已将 prefab 根节点加入当前 set-parent 记录 count=...
[creator-editor-fixes][override-recording-v6] 已同步 prefab 根节点已有 Transform 覆盖 count=...
[creator-editor-fixes][inspector-i18n-listener-leak] 已注入 Inspector i18n 监听泄漏修复 ...
[creator-editor-fixes][inspector-i18n-listener-leak] 已加载内存补丁 asset.js
[creator-editor-fixes][inspector-i18n-listener-leak] 已加载内存补丁 node.js
```

Inspector 泄漏修复的效果可以在 Chrome DevTools 的 Memory 面板里看：反复选中/取消选中多材质 MeshRenderer 节点后手动 GC，堆快照里不应再看到持续增长的 `i18n:change` 监听闭包。

## 附带工具：prefab 跨节点引用体检

除了三个修复模块，仓库里还有一个面向**业务项目**的只读体检工具，用于查 Creator 3.8.3 上那个古老的坑：脚本引用 prefab 实例内部的节点/组件（序列化为 `cc.TargetOverrideInfo`），偶发在重新打开场景后变成 `null`，而编辑器和运行时都不报错。

```bash
npm run check:refs -- "E:/path/to/CocosProject"                       # 扫全部 .scene 与 .prefab
npm run check:refs -- "E:/path/to/CocosProject" --scene               # 只扫场景
npm run check:refs -- "E:/path/to/CocosProject/assets/x.scene" --verbose
```

它不靠猜，而是把引擎的恢复流程整个复刻了一遇：`applyTargetOverrides` 的每个 `continue`/`return` 分支、`generateTargetMap` 的层级规则、`createNodeWithPrefab` 从 asset 重建子树的行为、`applyMountedChildren` 向 targetMap 补登记的时机。因此能区分三类结果：

| 分类 | 含义 |
| --- | --- |
| `ok` | 能被引擎正确恢复，并给出目标（`player.prefab -> component backpack_full_tip/...`） |
| `BAD` | 运行时必然为 `null`，并指出原因（source/sourceInfo 皮空、target 为 null、localID 断链、localID 层级不符并给出正确层级……） |
| 无害脏数据 | 挂在 prefab 实例根节点上的 `targetOverrides`。引擎从不读它们（`applyTargetOverrides` 不递归子节点），单独计数以免污染真问题 |

报告里会把脚本的压缩 uuid 解回文件名（`64329eme4BCvIqYi7uZZt2h` → `ItemPanel.ts`），并给出节点全路径，方便直接在 Inspector 里找到字段重拖。存在 BAD 时退出码为 1，可接 CI。

背景、引擎源码依据与已排除/已实证的假设看 `ISSUE-prefab-target-overrides-lost.md`。

## 适用版本

当前插件针对以下版本验证：

```text
Cocos Creator 3.8.3
```

其他版本的 Creator 内部 scene/undo 实现可能不同，所以三个修复都带硬版本守卫：`Editor.App.version` 不等于 `3.8.3` 时，Inspector 包装不注入、scene hook 不安装，并输出一次 warning。升级编辑器后要先把 `source/editor-version.ts` 里的 `SUPPORTED_EDITOR_VERSION` 改成新版本并跑 `npm run verify`，确认内部 API 没变再启用。
