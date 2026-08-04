# 待调查：场景中指向 prefab 实例内部节点/组件的引用偶发丢失

> 状态：仅完成机制梳理与现场取证，机制已对着引擎源码核实；静态体检工具已交付（`scripts/check-target-overrides.js`）并在业务工程拓到 **9 条确定失效**的引用；「场景级记录偶发丢失」的触发条件仍需坏样本才能定位。
> 目标 Creator 版本：3.8.3（与本插件其余修复一致）。
> 记录时间：2026-07-27；核实与工具交付：同日。

## 1. 现象

场景里的组件属性引用了某个 **prefab 实例内部**的节点或组件（例如 UI 上的 `ItemPanel` 引用玩家 prefab 里的 `BackPack` 组件）。

- 大多数时候正常：保存、重开工程、切场景后引用都还在，运行时也能取到对象。
- **偶发**丢失：运行时该字段为 `null`，业务逻辑静默失效（UI 不刷新、组件找不到目标等），编辑器和运行时**都没有任何报错或警告**。
- 手动在 Inspector 里把目标重新拖一次并保存，即恢复正常。

首次发现的业务案例（另一个工程，仅作参考）：场景节点 `Main/Canvas_2d/layer_low/item_panel` 上的 `ItemPanel.entries[0].backPack` 引用玩家 prefab 内的 `BackPack` 组件，运行时为 `null`，导致金币 UI 数字不刷新。

## 2. 这类引用在 Creator 3.8.3 里的存储机制

关键前提：**字段本身序列化为 `null` 是正常的**，不能凭 `"backPack": null` 判断引用丢失。真正的引用记录在 `targetOverrides` 中。

正确形态（实测好样本，来自 `Main.scene`）：

```jsonc
// 1) 组件字段本身为 null —— 正常
{"__type__":"ItemPanelEntry","backPack":null,"backPackType":1,"valueLabel":{"__id__":6574}}

// 2) 场景级 PrefabInfo（root/asset 均为 null，fileId = 场景 uuid）持有 targetOverrides 列表
{"__type__":"cc.PrefabInfo","root":null,"asset":null,
 "fileId":"c4891cd4-2c3a-4278-82fe-2508d5d347b3","instance":null,
 "targetOverrides":[{"__id__":6764}, "...", {"__id__":7553}]}

// 3) 真正的引用记录
{"__type__":"cc.TargetOverrideInfo",
 "source":{"__id__":6579},          // 持有属性的组件（场景原生节点上的 ItemPanel）
 "sourceInfo":null,                 // source 不在 prefab 内时为 null
 "propertyPath":["entries","0","backPack"],
 "target":{"__id__":23},            // prefab 实例根节点
 "targetInfo":{"__id__":7554}}

// 4) 目标在 prefab 内的定位信息：localID = 目标组件/节点的 fileId
{"__type__":"cc.TargetInfo","localID":["cb+2u0RwVB2YpzPX7eVu4g"]}
```

运行时恢复流程（引擎源码位于 Creator 安装目录 `resources/resources/3d/engine/`）：

| 位置 | 作用 |
| --- | --- |
| `cocos/scene-graph/scene.ts:174`（`Scene._load`） | 先 `expandNestedPrefabInstanceNode(this)`，再 `applyTargetOverrides(this)` |
| `cocos/scene-graph/prefab/prefab.ts:205` | prefab 自身实例化时也会调用 `applyTargetOverrides(rootNode)` |
| `cocos/scene-graph/prefab/utils.ts:320` `applyTargetOverrides` | 逐条解析 `targetOverrides` 并回填属性 |
| `cocos/scene-graph/prefab/utils.ts:104` `generateTargetMap` | 构建 `instance.targetMap`：节点/组件 fileId **平铺**在同一层；只有遇到**嵌套** prefab 实例才新开一层 `targetMap[instance.fileId] = {}` |
| `cocos/scene-graph/prefab/utils.ts:140` `getTarget` | 用 `localID` 数组逐级索引 `targetMap` |

`applyTargetOverrides` 里有 **5 处 `continue` + 1 处 `return`**，任何一处不满足都会**静默丢弃**这条引用：

1. `source` 为空（`sourceInfo` 存在但 `sourceInstance.targetMap` 里找不到）；
2. `targetInfo` 为空；
3. `target` 节点没有 `prefab.instance` 或 `instance.targetMap`；
4. `getTarget(targetInfo.localID, targetMap)` 返回空（**fileId 对不上或层级对不上**）；
5. `propertyPath` 中间层为空（例如 `entries[0]` 不存在）；
6. `targetPropName` 为空时直接 `return`，**该节点后续所有 override 一起被跳过**。

这就是「偶发 + 无报错 + 极难查」的根源：编辑器与引擎在这条链路上零日志。

## 3. 已确认的事实（现场取证）

### 3.1 关键修正：59 条 `source == null` 不是坏指纹

按「条目挂在哪个 PrefabInfo 上」分层后，`Main.scene` 的 323 条分成两类，泾渭分明：

| 归属 | 条数 | 形态 | 引擎会读取吗 |
| --- | --- | --- | --- |
| **场景级** PrefabInfo（`root=null, asset=null`, fileId = 场景 uuid） | 264 | 263 条 `source=实例根 + sourceInfo`、1 条 `source=场景组件 + sourceInfo=null`，**坏 0 条** | 会，`Scene._load` 里 `applyTargetOverrides(this)` |
| **prefab 实例根节点**上的 PrefabInfo（`asset=xxx, instance=true`） | 59 | 全部 `source=null && sourceInfo=null` | **不会** |

59 条全来自 8 个 prefab（`barricade` ×25、`door_1`/`door_2`、`tower_choose_panel` ×2 等），全是 prefab **内部自引用**。对照 prefab 资源里的原始记录就能看出成因：

```text
barricade.prefab @48:  source=@45(业务脚本) sourceInfo=null target=@2 targetInfo=["27I6if..."]   ← 健康
Main.scene @2886:      source=null          sourceInfo=null target=@2887 targetInfo=["27I6if..."]   ← source 丢了
```

编辑器把 prefab 资源的 `targetOverrides` 复制进场景实例时丢了 `source`/`sourceInfo`（在 prefab 文件内 source 能用 `__id__` 直接引用，复制到场景后那个组件不在场景 JSON 里，本该写成 `source=实例根 + sourceInfo=localID`）。但引擎从不读这些：`applyTargetOverrides` **不递归子节点**，`expandPrefabInstanceNode` 里只调 mounted/removed/property 那几个，另一个调用点是 `Prefab.onLoaded` 对 prefab 资源自己的 data 根节点（用的是 prefab 文件里那份健康记录）。

**结论：这 59 条是无害的冗余脏数据，不要在它们上花精力。** prefab 内部自引用靠 prefab 资源自身恢复。

### 3.2 backPack 那条的真实形态

```text
@7553 path=entries.0.backPack  source=@6579(ItemPanel.ts)  sourceInfo=null
      target=@23(player prefab 实例根)  targetInfo=["cb+2u0RwVB2YpzPX7eVu4g"]
      归属：场景级 PrefabInfo
```

它就是上表里唯一那 1 条 `source=ok/sourceInfo=null`，属于「场景原生组件 → prefab 内部对象」这一类，也是**真正会被读、也真正会丢**的那一类。当前 264 条全健康（重拖修复后的状态），坏样本仍未留档。

### 3.3 实现体检工具时才发现的三个坑

这三点不处理会直接造成误报（它们曾让工具把 `Main.scene` 里 8 条健康记录误判为断链）：

1. **fileId 含 `/`**。fileId 用 base64 字符集，`baOm/vra5M6YKyFCmFkR84`、`33/wu4LXBIH7XWCpDYNcaj` 都是真实值，绝不能用 `/` 拼接或展示 `localID` 路径。
2. **嵌套实例内部节点不在 `_children` 里**。`door_2.prefab` 的 `broken_door2`(@48) `_parent=@2`，但 @2 的 `_children` 不含它 ——「未展开」状态下内部节点是游离对象，运行时 `createNodeWithPrefab` 会用 `instantiate._clone` 从 asset 重建整个子树。所以 targetMap 必须**跨资源递归**，且那一层的 key 取 asset 根的 fileId。
3. **fbx 内嵌 prefab 是 sub-asset**。`7f43c4d2-...@bb9ec`（importer=`gltf-scene`）磁盘上没有 `.prefab`，要读 `library/<uuid前2位>/<uuid>@<sub>.json` 导入产物（结构完全一致，能正常解析）。

另一个易错的直觉：**同一个对象从不同 target 视角看，localID 级数不同**。场景里 `target=door_2 实例根` 时是 2 级 `["baOm/vra5M6YKyFCmFkR84","9cuwPvIbpII6axjY923VWE"]`，而 `door_2.prefab` 里 `target=@2（内层实例根）` 时是 1 级 `["9cuwPvIbpII6axjY923VWE"]`，两者都正确。

### 3.4 已排除的假设

- `PrefabInstance.expanded` 没有 `@serializable`，不会被存进场景，运行时必定重新 expand 并重建 `targetMap` ——「targetMap 没生成」这条路走不通。
- 场景级 `nestedPrefabInstanceRoots` 当前有 569 条，完整覆盖全部 33 个被引用的实例根，所有 target 也都带 `prefab.instance` —— 当前健康，但这两项仍值得体检（该列表是保存时收集的，漏项就会静默失效）。

## 4. 待验证的触发假设

按可能性排序，都需要实机复现确认：

| # | 假设 | 预期的坏数据指纹 | 当前结论 |
| --- | --- | --- | --- |
| 1 | 被引用组件/节点在 prefab 中被删除后重建 → fileId 变化 | `targetInfo.localID` 在目标 prefab 里查不到 | 工具已能检出；本工程目前 0 例 |
| 2 | 目标位于嵌套 prefab 实例中，编辑器只写了一级 `localID` | `getTarget` 返回 null；层级与实际不符 | **本工程未出现**，编辑器写的级数是对的（参 3.3） |
| 3 | 对目标 prefab 执行 apply / revert / 拆分实例，导致 `instance.fileId` 或 `targetMap` 结构变化 | `target.prefab.instance` 缺失或 `targetMap` 键不匹配 | 工具已能检出；待复现 |
| 4 | 复制粘贴 / 拖动实例节点后保存，`source` / `target` 未被正确写入 | `source == null && sourceInfo == null`，或 `target == null` | **已实证**：`door_2.prefab` 与 `door_1.prefab` 的 `hitMeshRenderers` 用同一组 localID，door_2 是从 door_1 复制而来，第 3 条的 `target` 丢成了 null |
| 5 | 多人协作时 `.scene` 文件合并，`targetOverrides` 段落被丢掉 | 整条 `TargetOverrideInfo` 消失 | 静态体检无法发现（记录不存在就无从比对），需 SVN 历史 diff |
| 6 | 保存顺序问题：先保存场景后保存 prefab（或反之），fileId 与 `localID` 短暂不同步 | 与 #1 相同 | 工具已能检出；待复现 |

## 5. 建议的修复方向

按「先能看见，再能自愈」的顺序，前两步风险低、收益立刻可见：

**A. 静态体检（已完成）**

`scripts/check-target-overrides.js` 已交付，完全按引擎规则复刻判定，只读不改数据，退出码可接 CI：

```bash
npm run check:refs -- <项目根>                    # 扫 assets 下全部 .scene 与 .prefab
npm run check:refs -- <项目根> --scene            # 只扫场景
npm run check:refs -- <某个.scene> --verbose        # 列出健康条目的解析结果
```

检查项：propertyPath 空/末段空（引擎在这里是 `return`，会连带同一 apply 根后续所有引用）、source 与 sourceInfo 皆空、sourceInfo 指向非实例根、targetInfo/localID 缺失、target 为 null、target 非实例根、target 不在 `nestedPrefabInstanceRoots` 里、localID 在目标资源里不存在（断链）、localID 层级不符（会直接告诉你正确层级应该是什么）。

首轮在业务工程的结果：**278 ok / 9 BAD / 0 WARN**，9 条全在 prefab 资源文件里，都是 100% 确定失效（引擎必然 continue）：

| 文件 | 字段 | 原因 |
| --- | --- | --- |
| `enemy_boss.prefab` | `shadow` | source 与 sourceInfo 皆空 |
| `enemy_boss.prefab` | `weaponMeshRender`、`bodyMeshRender`、`skele` | target 为 null |
| `ally_guard.prefab` / `ally_soldier.prefab` | `affectedMeshRenderers.1` | source 与 sourceInfo 皆空 |
| `door_2.prefab` | `hitMeshRenderers.2` | target 为 null |
| `tower_defend_arrow.prefab` | `skeleAnimCtrl` | target 为 null |
| `tower_defend_arrowstorm.prefab` | `muzzle` | source 与 sourceInfo 皆空 |

这些字段在运行时永远是 `null`，业务上可能已经有静默异常（受击变色不全、炮口位置不对、第三块门碎片不响应之类），建议逐个在 Inspector 里重拖修复。

**A2. 编辑器内告警（未做，可选）**

场景打开/保存后在 scene 进程只读扫描当前场景树，发现断链就在 Console 报告。注意不要去 hook 引擎函数：编辑器里引擎是 bundle 产物，`applyTargetOverrides` 已被内联，替换 `cc.Prefab._utils` 导出不会影响 `Scene._load` 里的调用；自己按规则校验公开数据更安全。

**B. 引用意图持久化 + 自动重连（真正的自愈）**

复用本仓库 `prefab-child-lock-persistence` 的思路：把引擎不可靠的信息额外存一份到项目 Profile。

对每条跨 prefab 引用额外记录：`source 节点路径 + 组件类型 + propertyPath` → `目标 prefab uuid + 目标节点路径 + 目标组件类型/索引`。场景加载后若检测到该条 `targetOverrides` 断链，就按**路径 + 类型**重新解析并回填 `localID`，再提示用户保存。这样即使 fileId 变了也能自动恢复。

**C. 只有在 A/B 定位到确定性 bug（假设 #2 已排除，重点看 #1 / #3 / #6）后**，再考虑 hook 编辑器写入 `TargetInfo.localID` 的那段逻辑，让层级与 `generateTargetMap` 对齐。这一步侵入性最大，放最后。

## 6. 下一步需要的输入

1. **坏样本（仍是关键路径）**：下次复现时先把出问题的 `.scene`（以及被引用的 `.prefab`）复制留档，再手动重拖修复。拿到坏样本后第一件事就是对它跑 `npm run check:refs`，工具会直接指出是哪种失效。
2. **操作回放**：记录丢失前最近做过什么（改了 prefab？apply/revert？复制节点？合并过场景文件？）。已实证的 #4（复制粘贴）说明「复制带跨节点引用的节点」是高危操作。
3. **回归监控**：把 `npm run check:refs -- <项目根>` 接进日常流程（提交前或 CI），BAD 数从 9 变大就是新丢失发生的信号，同时能拓到是哪次操作弄坏的。
4. 如果以后要做编辑器内告警或自愈，按本仓库惯例先用 `scripts/verify-editor-internals.js` 的方式校验 3.8.3 内部签名再动手。

## 7. 取证工具

用 `scripts/check-target-overrides.js`（本仓库），不要再用简易版脚本 —— 简易判定不区分「会被引擎读的条目」与「实例根上的冗余脏数据」，也不做跨资源 targetMap 解析，会同时产生大量误报与漏报（参 3.1 / 3.3）。

```bash
npm run check:refs -- "E:/path/to/CocosProject"
npm run check:refs -- "E:/path/to/CocosProject/assets/scene/Main.scene" --verbose
```

输出形式：

```text
assets\scene\Main.scene
  apply 根 264 条: ok 264  | 实例根 59 条: 无害脏数据（引擎不读取）

assets\project\prefabs\env\door_2.prefab
  apply 根 5 条: ok 4  BAD 1
  BAD  @65 door_2 [BuildingHitComp.ts].hitMeshRenderers.2
       target 为 null（常见于复制粘贴节点后保存）
```

工具会把脚本的压缩 uuid（`__type__`，如 `64329eme4BCvIqYi7uZZt2h`）解回文件名（`ItemPanel.ts`），并把 `localID` 解成可读目标（`player.prefab -> component backpack_full_tip/...`），方便直接在 Inspector 里找到那个字段重拖。
