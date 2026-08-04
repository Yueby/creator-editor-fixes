# prefab-root-transform-override 修复原理

## 目标

修复 Cocos Creator 3.8.3 中 prefab 实例根节点切换父节点后，Transform override、场景保存、切换场景、撤销/重做状态不一致的问题。

典型表现：

- prefab 实例根节点拖入带非默认 Transform 的父节点后，Inspector 中显示的位置看起来正确。
- 保存并切换场景后，prefab 位置可能错位。
- Ctrl+Z / Ctrl+Y 后，父子关系恢复了，但 prefab 根节点本地 Transform 或 override 没有正确恢复。

## 根因

这里其实有两个相互独立的根因，一个决定「保存到场景文件的值对不对」，另一个决定「撤销/重做能不能恢复」。之前的文档只写了第二个。

### 根因一：prefab 根节点的 Transform 不是直接存节点，而是存在 prefab override 里

普通节点的本地 Transform 会作为节点自身字段（`_lpos` / `_lrot` / `_euler` / `_lscale`）直接序列化进场景文件。但 prefab 实例根节点不同：它的节点数据「归属」prefab 资源，场景文件里保存的是这个实例的挂载信息 + 一组 `PrefabInstance.propertyOverrides`（`PropertyOverrideInfo`，含 `targetInfo.localID` + `propertyPath` + `value`）。**prefab 根节点相对父节点的本地 Transform，正是通过这些 override 条目持久化的，而不是直接读节点上的 `_lpos`。**

reparent 时，Creator 会更新节点内存里的实时 Transform（`node._lpos` 等），让编辑器视图里的世界位置看起来正确；但它**没有把这份新的实时 Transform 同步回对应的 `propertyOverrides` 条目**。于是内存和序列化数据出现分叉：

```text
prefab 实例根节点（reparent 后）
  node._lpos / _lrot / _euler / _lscale   → 已更新，视图正确
  propertyOverrides 中对应条目的 value      → 仍是旧值（stale）
```

保存场景时序列化走的是 `propertyOverrides`，所以写进 `.scene` 文件的是旧值。当前场景没重新反序列化，所以看起来正常；一旦切换场景 / 重新加载，prefab 用文件里的旧 override 值重建，位置就错位了。多次移入移出会让旧值持续偏离实时值，于是出现累积偏移。

这一层才是「为什么 prefab 没能把 Transform 存进场景文件」的真正原因，也是本模块 `syncExistingTransformOverrides` 要解决的核心：在 recording 内把实时 `node._lpos/_lrot/_euler/_lscale` 回写进已有的 override 条目，让序列化值与视图一致。

### 根因二：set-parent 的 undo command 没有包含 prefab 根节点 child

即使 override 值被修正，撤销/重做还需要这份修改进入同一个原始 undo command 才能被正确回滚。

Creator 3.8.3 的 `set-parent` recording 在 prefab 根节点 reparent 场景中，只把旧父节点和新父节点放进原始 undo command 的数据集。实际 reparent 过程中，prefab 根节点 child 会触发 `SceneUndoManager.record(child)`，但这个 `record(child)` 只进入临时 records，并不会把 child 加入当前 `SceneUndoCommand.uuids`、`undoData`、`redoData`。

结果是：

```text
set-parent command
  undoData: 旧父节点、新父节点
  redoData: 旧父节点、新父节点
  缺少: prefab 根节点 child
```

因此 undo/redo 只恢复层级关系相关节点，却没有完整恢复 prefab 根节点自己的 Transform / prefab override 状态。修正后的 override 值如果不进这个 command，撤销/重做同样会丢失。

## 修复策略

本模块不创建新的 undo 记录，也不调用 `scene:set-property`、`cce.Node.setProperty`、`scene:snapshot`。

修复点是在 Creator 原始 `set-parent` recording 内补全这个 command：

1. hook `GeneralSceneFacade.prototype.setNodeParent`。
2. 在 Creator 原始 set-parent 执行前，找到当前 active `SceneUndoCommand`。
3. 判断 payload 中的 child 是否是 prefab 实例根节点。
4. 把 prefab 根节点 child uuid 加入当前 command。
5. 调用 Creator 原始 `_setUndo(command, childUuid)`，捕获 reparent 前的 child 状态。
6. 让 Creator 原始 set-parent 和 `endRecording` 继续执行。
7. 在 `endRecording` 后，同步 prefab 根节点已有的 Transform override。
8. 调用 Creator 原始 `_setRedo(command, childUuid)`，把同步后的 child 状态写回同一个 redoData。
9. undo/redo applyData 时使用 child-first 顺序，避免视觉闪动。

最终 command 变成：

```text
set-parent command
  undoData: 旧父节点、新父节点、prefab 根节点 child
  redoData: 旧父节点、新父节点、prefab 根节点 child
```

这样 prefab 根节点状态和父子关系进入同一个原始 undo/redo command。

其中第 7 步（同步已有 override）解决根因一（保存到场景文件的值），第 1–6、8–9 步（补 child、纳入原始 command、child-first apply）解决根因二（撤销/重做与视觉闪动）。

## 条目定位为何必须严格匹配

引擎在 `prefab-info.ts` 里判定一条 override 是不是目标，用的是 `compareStringArray`（等长逐元素全等）：

```ts
public isTarget (localID: string[], propPath: string[]): boolean | undefined {
    return compareStringArray(this.targetInfo?.localID, localID)
        && compareStringArray(this.propertyPath, propPath);
}
```

`TargetInfo.localID` 是 `string[]` 而不是单个 fileId，因为嵌套 prefab 需要用多级路径定位；`propertyPath` 同样可以是 `['_lpos','x']` 这种分量级路径（`applyPropertyOverrides` 会 `pop()` 最后一级再逐级下钻）。

所以条目定位不能用 `includes` 这类宽松匹配，否则：

- `localID = ['OUTER', 'ROOT_FILE']`（嵌套 prefab 内层节点）会被当成当前根节点的条目。
- `propertyPath = ['_lpos', 'x']`（number 属性）会被当成整条 `_lpos`，把 Vec3 写进一个分量里。

当前实现优先调引擎自带的 EDITOR-only API `instance.findPropertyOverride([fileId], [transformKey])`，它内部就是上面的 `isTarget`；只在该 API 不可用时，才回退到自己实现的等价严格数组比较。

## 为什么只更新已有 Transform override

本模块只更新 prefab 根节点已有的 Transform override 条目：

```text
_lpos
_lrot
_euler
_lscale
```

如果某个条目不存在，只记录 debug warning，不主动创建新的 `PropertyOverrideInfo` / `TargetInfo`。换句话说，本修复的前提是“Creator 已经为该 prefab 实例建过 Transform override 条目，只是值是旧的”；若某个字段从未产生过 override，本模块不会为它新建条目。

原因是 Creator 3.8.3 的 prefab override 序列化结构属于内部实现，手动创建缺失条目风险较高，可能破坏 prefab instance 序列化数据。当前安全边界是：

```text
只修正已有 override 条目的值，不创建新的 override 条目。
```

## Hook 范围

本模块运行在 scene 进程，当前 patch 版本：

```text
override-recording-v6
```

v6 相对 v5 的变化：

- `set-parent` 的 `uuids` 允许 `string | string[]`（`CutNodeOptions`，且 `set-parent` 是 public 消息），v5 只处理数组，传单字符串时修复会静默失效。
- override 条目定位改为引擎 `findPropertyOverride` + 严格数组比较，v5 的 `includes` 会误伤嵌套 `localID` 与分量级 `propertyPath`。
- `endRecording` 只处理 `args[0] === state.recordingId` 的那次 recording；v5 无条件清理状态，auto/manual command 交错时会把进行中的 recording 弄丢。
- `applyData`/`undo`/`redo` 的 applying 计数增加超时兜底与不小于 0 的保护，避免一次未 settle 的 promise 就让修复永久被跳过。
- 只在 `Editor.App.version === '3.8.3'` 时安装；关键安装失败（找不到内部实现、patch 数量不足、缺 `_setUndo`/`_setRedo`）不再只写 debug 日志，而是输出一次 warning。

hook 的内部方法包括：

```text
GeneralSceneFacade.prototype.setNodeParent
SceneUndoManager.prototype.beginRecording
SceneUndoManager.prototype.endRecording
SceneUndoCommand.prototype.applyData
SceneUndoCommand.prototype.undo
SceneUndoCommand.prototype.redo
```

这些 hook 只影响编辑器 scene 进程，不影响游戏运行时。

## 安全边界

本模块明确避免：

- 不修改 Creator 安装目录。
- 不直接写 `.scene` / `.prefab` 文件。
- 不创建独立 undo command。
- 不调用 `scene:set-property`。
- 不调用 `cce.Node.setProperty`。
- 不调用 `scene:snapshot`。
- 不使用延迟 timer 在 recording 外修补 Transform。
- 不新增 prefab override 条目。

## 验证方式

自动校验（不需要安装 Creator，用假的 undo/facade 实现真跑 dist）：

```bash
npm run build
node scripts/verify-scene-fixes.js
```

覆盖：uuids 传 string、已有 `_lpos` 条目被同步为节点实时值、克隆而不共享引用、嵌套 `localID` 与分量级 `propertyPath` 干扰条目不被改动、`redoData` 同步、child-first 顺序、`endRecording` 收到无关 id、uninstall 还原、版本守卫。

内部 API 校验（需要本机 Creator 3.8.3）：

```bash
node scripts/verify-editor-internals.js
```

手工验证建议使用一个带非默认 Transform 的父节点 `Parent`：

1. 将 prefab 实例根节点拖入 `Parent`。
2. 保存并切换场景，确认位置不变。
3. 将 prefab 实例根节点拖出 `Parent`。
4. 保存并切换场景，确认位置不变。
5. 测试 Ctrl+Z / Ctrl+Y，确认父子关系与位置都正确。
6. 多选多个 prefab 实例根节点重复上述操作。
