# prefab-active-override-sync

## 问题

Cocos Creator 3.8.3 里，用 scene 包的快捷键（`toggle-active-selected-node`）取消激活 prefab 实例内的节点后，节点在编辑器里确实变成未激活，但保存场景后再切换场景/重开，节点又恢复成激活。

## 根因

prefab 实例内节点的 `active` 不存在节点自身，而是序列化为 `PrefabInstance.propertyOverrides` 里 `propertyPath = ['_active']` 的条目。该条目由 `PrefabManager.onNodeChangedInGeneralMode` 在节点变更通知时生成。

实测对比（在运行中的编辑器里读取同一批 `木桩` 实例的内存状态）：

| 取消激活方式 | 内存里 `propertyOverrides` |
|---|---|
| Inspector 的 Active 勾选框 | `_lpos`、`_lrot`、`_euler`、`_active=false` |
| 快捷键 `toggle-active-selected-node` | 只有 `_lpos` 等，没有 `_active` |

也就是说快捷键路径只改了 `node.active`，没有通知 `PrefabManager`，`_active` override 没生成，保存时自然不会写进 `.scene`。这不是切换场景的问题，是保存前就缺了。

## 修复

hook `GeneralSceneFacade.prototype.toggleActiveSelectedNode`：

1. 原方法执行前，记录当前选中的节点 uuid。
2. 执行原方法，保持原有的激活切换与 undo 行为不变。
3. 执行后，对每个位于 prefab 实例内（自身是实例根或祖先中有实例根）的选中节点，调用 `PrefabManager.onNodeChangedInGeneralMode(node, { source: 'editor', type: 'set-property', propPath: 'active', record: false }, sceneRoot)`，让编辑器按 Inspector 路径同样的逻辑生成 `_active` override。

普通节点（不在任何 prefab 实例内）不处理，它们的 `_active` 本来就由场景原生序列化。

## 安全边界

- 只在 `Editor.App.version === '3.8.3'` 时安装；其它版本输出一次 warning 并跳过。
- 不修改 Creator 安装包，不修改场景文件格式。
- hook 失败时只输出 warning，原快捷键行为不受影响；卸载扩展时 `uninstallEditorHooks` 会还原原方法。
- `toggleActiveUnselectedNode`、`toggleActiveAllNodes` 目前没有处理，如果它们同样走快捷键路径且存在同样的问题，需要另行验证。

## 验证

问题本身（快捷键路径缺 `_active` override、Inspector 路径正常）已在 3.8.3 编辑器内存里实测确认。

修复后的结果仅由使用者在编辑器里观察到"取消激活不再恢复"，**尚未**读取修复后节点的 `propertyOverrides` 或保存后的 `.scene` 确认 `_active` 条目已生成；`type: 'set-property'` 这个变更类型也是按 Inspector 路径推断的。

仍需注意：

- 该修复没有单独接入 undo。撤销/重做的行为取决于编辑器内部实现，需要在实际编辑器里验证。
- 建议修复后取消激活一个 prefab 实例节点并保存场景，确认 `.scene` 中新增了对应的 `_active` 条目。
