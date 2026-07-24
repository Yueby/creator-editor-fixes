# Creator Editor Fixes

用于集中维护 **Cocos Creator 3.8.3** 编辑器侧修复的扩展插件。

当前包含的修复模块：

```text
prefab-root-transform-override
inspector-i18n-listener-leak
```

该模块修复 prefab 实例根节点在编辑器内调整父节点后，Transform override 保存、切换场景、撤销/重做状态不一致的问题。

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
override-recording-v5
```

Inspector i18n 监听泄漏修复使用 `creator.hookScript` 仅在 `Editor.App.version === '3.8.3'` 时动态注入：

```text
contributions.inspector.type.asset -> dist/fixes/inspector-i18n-listener-leak/asset.js
contributions.inspector.type.node  -> dist/fixes/inspector-i18n-listener-leak/node.js
```

包装模块会从当前 Creator 安装目录读取原始 3.8.3 Inspector contribution 文件，在内存中精确替换并编译，不修改 Creator 安装包，也不覆盖 `require.cache`。如果原始代码匹配次数不是 1，会关闭补丁并回退加载原始文件。

扩展版本：

```text
1.0.13
```

## 使用到的编辑器内部 hook

插件运行在 Creator 的 scene 进程中，会在运行时 hook 以下编辑器内部方法：

```text
GeneralSceneFacade.prototype.setNodeParent
SceneUndoManager.prototype.beginRecording
SceneUndoManager.prototype.endRecording
SceneUndoCommand.prototype.applyData
SceneUndoCommand.prototype.undo
SceneUndoCommand.prototype.redo
```

这些 hook 只在编辑器内生效，不影响游戏运行时。

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
- Inspector 修复不贡献 header/section/footer，仅覆盖 `type.asset` 与 `type.node`。

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
│  ├─ main.ts                                # 编辑器主进程入口，负责安装 scene hook
│  ├─ scene.ts                               # scene 进程入口，委托到修复模块
│  ├─ debug.ts                               # Debug 日志开关
│  └─ fixes/
│     ├─ prefab-root-transform-override/     # override-recording-v5 修复
│     │  ├─ index.ts
│     │  └─ README.md                        # override-recording-v5 修复原理
│     └─ inspector-i18n-listener-leak/       # Inspector i18n 监听泄漏修复
│        ├─ hook.ts
│        ├─ patcher.ts
│        ├─ asset.ts
│        ├─ node.ts
│        └─ README.md                        # Inspector 修复原理
├─ scripts/
│  ├─ package-dist.js
│  └─ verify-inspector-i18n-listener-leak.js
├─ dist/
│  ├─ main.js
│  ├─ scene.js
│  ├─ debug.js
│  ├─ fixes/
│  │  ├─ prefab-root-transform-override.js
│  │  └─ inspector-i18n-listener-leak/
│  │     ├─ hook.js
│  │     ├─ patcher.js
│  │     ├─ asset.js
│  │     └─ node.js
│  ├─ package.json
│  └─ creator-editor-fixes-1.0.13.zip
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

1. TypeScript 编译。
2. 生成发布用 `dist/package.json`。
3. 生成可导入编辑器的 zip 包。

构建产物：

```text
dist/creator-editor-fixes-1.0.13.zip
```

zip 内包含：

```text
main.js
scene.js
debug.js
fixes/prefab-root-transform-override/index.js
fixes/inspector-i18n-listener-leak/hook.js
fixes/inspector-i18n-listener-leak/patcher.js
fixes/inspector-i18n-listener-leak/asset.js
fixes/inspector-i18n-listener-leak/node.js
package.json
```

## Debug 日志开关

默认不输出修复命中、校验、uuid 列表等调试日志，避免影响编辑器控制台性能。

如需排查问题，可修改：

```text
source/debug.ts
```

将：

```ts
export const DEBUG = false;
```

改为：

```ts
export const DEBUG = true;
```

然后重新执行：

```bash
npm run build
```

也可以在对应进程中临时设置全局标记：

```js
globalThis.__creatorEditorFixesDebug__ = true;
```

## 导入编辑器

在 Cocos Creator 扩展管理器中导入：

```text
dist/creator-editor-fixes-1.0.13.zip
```

导入后重启或重载扩展，使 scene hook 生效。

## 验证方式

建议使用一个带非默认 Transform 的父节点 `Parent` 测试：

1. 将 prefab 实例根节点拖入 `Parent`。
2. 保存并切换场景，确认位置不变。
3. 将 prefab 实例根节点拖出 `Parent`。
4. 保存并切换场景，确认位置不变。
5. 测试 Ctrl+Z / Ctrl+Y，确认父子关系与位置都正确。
6. 多选多个 prefab 实例根节点重复上述操作。

日志中应能看到类似信息：

```text
[creator-editor-fixes][override-recording-v5] 已安装 override recording 最小修复
[creator-editor-fixes][override-recording-v5] 已将 prefab 根节点加入当前 set-parent 记录 count=...
[creator-editor-fixes][override-recording-v5] 已同步 prefab 根节点已有 Transform 覆盖 count=...
[creator-editor-fixes][inspector-i18n-listener-leak] 已注入 Inspector i18n 监听泄漏修复 ...
[creator-editor-fixes][inspector-i18n-listener-leak] 已加载内存补丁 asset.js
[creator-editor-fixes][inspector-i18n-listener-leak] 已加载内存补丁 node.js
```

可执行静态校验：

```bash
node scripts/verify-inspector-i18n-listener-leak.js
```

如本机 Creator 3.8.3 不在默认位置，请先设置：

```bash
set COCOS_CREATOR_383_PATH=C:\ProgramData\cocos\editors\Creator\3.8.3
```

## 适用版本

当前插件针对以下版本验证：

```text
Cocos Creator 3.8.3
```

其他版本的 Creator 内部 scene/undo 实现可能不同，不保证兼容。
