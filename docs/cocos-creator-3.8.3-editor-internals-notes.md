# Cocos Creator 3.8.3 编辑器内部探查经验

本文记录开发 `prefab-transform-override-fixer` 过程中，对 Cocos Creator 3.8.3 编辑器内部资源、scene 进程模块、undo/redo 机制和 prefab override 保存链路的探查结论。

这些结论主要用于后续维护本插件，或排查类似“编辑器内实时状态正确，但保存/切场景/撤销重做不一致”的问题。

## 1. Creator 安装资源位置

本次验证的 Creator 版本：

```text
Cocos Creator 3.8.3
```

Windows 下安装资源主要位于：

```text
C:\ProgramData\cocos\editors\Creator\3.8.3\resources\app.asar
```

scene 相关内置包位于：

```text
C:\ProgramData\cocos\editors\Creator\3.8.3\resources\app.asar\builtin\scene
```

在扩展的 scene 进程内，可通过：

```ts
Editor.App.path
```

拼出 Creator app 根目录，再定位到：

```text
builtin/scene
```

## 2. `.ccc` 文件不是普通 JavaScript

Creator 3.8.3 的 scene 编辑器内部逻辑大量位于：

```text
builtin/scene/dist/script/**/*.ccc
```

这些 `.ccc` 文件不是可直接阅读的普通 JS，也不是 zip/gzip 一类常规压缩文本。

相关加载逻辑可在以下文件中看到：

```text
node_modules/@editor/creator/dist/require.js
```

其中注册了类似：

```js
Module._extensions['.ccc'] = ...
```

最终通过 Creator/Electron 内部 binding 执行：

```text
process._linkedBinding('electron_common_compile')
```

结论：

- 不适合直接修改 `.ccc` 文件。
- 不应把修复建立在“反编译并替换 Creator 内置文件”上。
- 更安全的方式是在 Creator 运行时 require 已加载模块并 monkey patch prototype。

## 3. 扩展 scene 脚本可以 require 内部 `.ccc` 模块

虽然 `.ccc` 不能直接阅读，但在 Creator 的 scene 进程中，扩展脚本可以 require 到这些模块。

本插件最终使用的是运行时 hook 方案，通过 scene 脚本 require 内部模块并 patch prototype。

关键模块路径：

```text
builtin/scene/dist/script/3d/facade/general-scene-facade.ccc
builtin/scene/dist/script/export/undo/scene.ccc
```

可用导出：

```text
facade/general-scene-facade -> GeneralSceneFacade / default
export/undo/scene -> SceneUndoCommand / SceneUndoManager
```

注意：undo 模块不在 `dist/script/3d/export/undo`，真实路径是：

```text
dist/script/export/undo
```

这是前期探查时踩过的路径坑。

## 4. 本次确认过的内部模块与对象

以下模块在 Creator 3.8.3 scene 进程中可 require：

```text
manager/node/index
manager/prefab/index
manager/prefab/node
manager/prefab/utils
manager/message
facade/general-scene-facade
facade/scene-facade-manager
export/undo/scene
export/undo/base
```

重要导出和对象：

```text
manager/node/index -> NodeManager / default
manager/prefab/index -> PrefabManager / default
manager/prefab/node -> nodeOperation
manager/prefab/utils -> PrefabState / prefabUtils
facade/general-scene-facade -> GeneralSceneFacade / default
facade/scene-facade-manager -> SceneFacadeManager
export/undo/scene -> SceneUndoCommand / SceneUndoManager
export/undo/base -> UndoCommand / UndoManagerBase
```

运行时观察：

- `cce.Node` 是 `NodeManager` 实例。
- `NodeManager.prototype.setParent` 存在。
- `NodeManager.prototype.onNodeParentChanged` 存在。
- `cce.Node._onParentChanged` 是已绑定的 listener。
- `GeneralSceneFacade.prototype.setNodeParent` 存在，是本次最合适的主 hook 点。
- `SceneUndoManager.prototype` 暴露：
  - `beginRecording`
  - `endRecording`
  - `record`
  - `updateDump`
  - `_setUndo`
  - `_setRedo`
- `SceneUndoCommand.prototype` 暴露：
  - `applyData`
  - `undo`
  - `redo`

## 5. 为什么最终没有选择 NodeManager parent-change 方案

早期尝试过从 NodeManager / parent-change 事件切入，但最终废弃。

原因：

- `cce.Node._onParentChanged` 是启动时绑定好的函数。
- 仅替换 prototype 方法不一定能影响已绑定 listener。
- 重新注册 NodeManager 事件风险高，且可能影响编辑器内部状态。
- parent-change 发生时，很难可靠地保证处于原始 undo recording 的正确阶段。

最终代码中不应再出现 NodeManager / parent-change 作为主方案的命名或注释。

## 6. set-parent 的真实问题

通过 call trace 确认：Creator 原始 set-parent recording 只把以下对象纳入 undo command：

```text
scene
Parent
```

没有把 prefab instance root child 纳入：

```text
prefab root child
```

虽然 parent-change 过程中会出现 `record(child)`，但它不会自动把 child 加入：

```text
SceneUndoCommand.uuids
undoData
redoData
```

因此只靠 `record(child)` 不足以修复 undo/redo 和保存链路。

## 7. 最终主 hook 点

最终选择：

```text
GeneralSceneFacade.prototype.setNodeParent
SceneUndoManager.prototype.beginRecording
SceneUndoManager.prototype.endRecording
SceneUndoCommand.prototype.applyData
SceneUndoCommand.prototype.undo
SceneUndoCommand.prototype.redo
```

### `GeneralSceneFacade.prototype.setNodeParent`

主原因：

- 可以拿到 set-parent payload。
- payload 里有 child uuid 列表。
- 执行时位于原始 `beginRecording` 之后、实际 setParent 之前。
- 适合在原始 recording 内把 prefab root child 补进 command。

### `SceneUndoManager.prototype.beginRecording`

只用于记录当前 active undo manager 和 recording id。

不改变原始行为。

### `SceneUndoManager.prototype.endRecording`

用于在原始 endRecording 后，同步已有 Transform override 并刷新 redoData。

### `SceneUndoCommand.prototype.applyData`

用于 undo/redo 应用时调整本次 Map 顺序，避免可见闪动。

## 8. 最终修复步骤

最终版本：

```text
override-recording-v5
```

核心流程：

1. `beginRecording` 时记录 active recording id。
2. `setNodeParent` 原始逻辑执行前：
   - 找到 payload 中的 prefab root child。
   - 找到当前 active command。
   - 将 child uuid 加入 `command.uuids`。
   - 调用原始 `_setUndo(command, childUuid)` 捕获旧状态。
3. `endRecording` 原始逻辑执行后：
   - 读取 child 当前 live `_lpos/_lrot/_euler/_lscale`。
   - 更新 prefab root 已存在的 Transform override 条目。
   - 调用原始 `_setRedo(command, childUuid)` 刷新 redoData。
   - 如果 `_setRedo` 失败，回滚本次 override 替换。
4. `applyData` 时：
   - 不改原始 undoData/redoData。
   - 只为本次 apply 创建 child-first Map。
   - 减少 undo/redo 时的可见闪动。

## 9. 关于 prefab Transform override 的经验

prefab instance root 的 Transform override 通常在实例的 override 列表中，目标 localID 对应：

```text
child._prefab.fileId
```

需要处理的字段：

```text
_lpos
_lrot
_euler
_lscale
```

经验点：

- localID 可能是字符串，也可能是数组 `[fileId]`。
- property path 可能是数组，也可能是字符串。
- 只更新已有条目，不新增条目，风险更低。
- 不要原地改旧 value 的数字字段，容易产生引用污染。
- 更安全的方式是 clone Transform value 和 override entry，再替换回列表同 index。

## 10. 已验证不可取的方案

以下方案已验证或评估为不适合作为最终方案：

### `scene:set-property`

会改 live Transform，并破坏原始 undo 行为。

### `cce.Node.setProperty`

即使 `record=false`，仍会改变 live Transform，并在多次 reparent 后产生累计漂移。

### `scene:snapshot`

会引入额外 dirty/undo 行为，不符合“只扩展原始 set-parent command”的目标。

### 延迟修复

例如 reparent 后再延迟写 metadata，容易发生：

- 保存链路时机不稳定。
- undo 后 metadata 留在错误状态。
- 与原始 undo command 脱节。

### 单纯调用 prefab syncer

如 `nodeOperation.syncPropertyOverrides` 或 `PrefabManager.onNodeChangedInGeneralMode`，本次验证中没有写入需要的 Transform override。

### 修改 Creator 安装包

风险高，不利于分发和维护。最终没有采用。

## 11. 调试建议

后续如果 Creator 小版本变化导致插件失效，优先检查：

1. `GeneralSceneFacade.prototype.setNodeParent` 是否仍存在。
2. `SceneUndoManager.prototype._setUndo/_setRedo` 是否仍存在。
3. `SceneUndoCommand.prototype.applyData` 是否仍使用 Map。
4. prefab root 的 `_prefab.fileId` 与 override entry localID 结构是否变化。
5. override entry 的 `value` 是否仍是 data descriptor。

推荐先做只读 introspection/trace，不要直接恢复旧的 setProperty 或 snapshot 路径。

## 12. 当前发布方式

构建：

```bash
npm install
npm run build
```

发布包：

```text
dist/creator-editor-fixes-1.0.13.zip
```

zip 内包含：

```text
main.js
scene.js
debug.js
fixes/prefab-root-transform-override/index.js
package.json
```

导入 Creator 编辑器时使用该 zip 即可。
