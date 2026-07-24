# inspector-i18n-listener-leak 修复原理

## 目标

修复 Cocos Creator 3.8.3 中反复切换 Inspector 属性面板导致编辑器内存上涨的问题，尤其是切换带多个 Material 的 `MeshRenderer` 组件时更明显。

该问题在 Cocos Creator 3.8.4 已由官方修复。本模块将 3.8.4 中确认的最小修复点 backport 到 3.8.3。

## 根因

Creator 3.8.3 的 Inspector `node` / `asset` contribution 会注册 `i18n:change` broadcast listener，但 listener 生命周期管理不完整。

关键问题在：

```text
resources/resources/3d/engine/editor/inspector/contributions/asset.js
resources/resources/3d/engine/editor/inspector/contributions/node.js
```

### asset.js 问题

3.8.3 中，asset Inspector 面板 ready 时注册：

```js
Elements.panel.i18nChangeBind = Elements.panel.i18nChange.bind(panel);
Editor.Message.addBroadcastListener('i18n:change', Elements.panel.i18nChangeBind);
```

但 close 时没有移除 `i18n:change` listener。

当 Inspector 反复创建/关闭 asset 子面板时，旧 listener 可能持续持有旧 panel 的闭包引用，导致旧 panel / DOM / 状态不能被 GC。

### node.js 问题

3.8.3 中，node Inspector 也把 listener 存在模块级字段：

```js
Elements.node.i18nChangeBind = Elements.node.i18nChange.bind(panel);
Editor.Message.addBroadcastListener('i18n:change', Elements.node.i18nChangeBind);
```

close 时也按模块级字段移除：

```js
Editor.Message.removeBroadcastListener('i18n:change', Elements.node.i18nChangeBind);
```

模块级字段会被后创建的 panel 覆盖，多个 panel / 子 panel 并存或切换时，旧 panel 可能无法移除自己注册的 listener。

## 为什么多 Material 的 MeshRenderer 更明显

`MeshRenderer.materials` 在 Inspector 中会创建多个 Material/asset 子面板：

```text
MeshRenderer
  Material 0 子面板
  Material 1 子面板
  Material 2 子面板
  ...
```

每个子面板都可能注册 `i18n:change` listener。3.8.3 没有正确释放时，泄漏会随 Material 数量放大。

## 3.8.4 的修复点

3.8.4 的改动集中在 `contributions/asset.js` 和 `contributions/node.js`。

核心变化是：

1. listener 存到 panel 实例字段，而不是模块级字段。
2. panel close 时按当前 panel 实例移除 listener。

例如 `asset.js` 从：

```js
Elements.panel.i18nChangeBind = Elements.panel.i18nChange.bind(panel);
Editor.Message.addBroadcastListener('i18n:change', Elements.panel.i18nChangeBind);
```

变为：

```js
panel.i18nChangeBind = Elements.panel.i18nChange.bind(panel);
Editor.Message.addBroadcastListener('i18n:change', panel.i18nChangeBind);
```

并在 close 时补充：

```js
Editor.Message.removeBroadcastListener('i18n:change', panel.i18nChangeBind);
```

## 本模块如何 backport

本模块不修改 Creator 安装目录，也不直接复制 3.8.4 的完整文件。

实现方式：

1. 通过 `creator.hookScript` 在扩展注册阶段运行 `hook.js`。
2. 仅当 `Editor.App.version === '3.8.3'` 时动态注入：

```text
contributions.inspector.type.asset = <本插件 asset wrapper 绝对路径>
contributions.inspector.type.node  = <本插件 node wrapper 绝对路径>
```

3. wrapper 读取当前 Creator 3.8.3 安装目录中的原始 contribution 文件。
4. 对原始源码做 exact string replacement。
5. 每个 replacement 必须命中 exactly 1 次。
6. 使用 `Module._compile` 在内存中编译 patched source。
7. `filename` / `__dirname` 指向原始 engine 文件路径，保持相对 require 行为。
8. 不覆盖 `require.cache[originalPath]`。
9. 如果 patch 匹配失败，fail closed，回退加载原始模块。

## 为什么不用 runtime listener capture

曾考虑在 wrapper 的 `ready()` 期间临时包裹 `Editor.Message.addBroadcastListener` 捕获 `i18n:change` listener，再在 close 时移除。

最终没有采用，因为 `node.js` 的 `ready()` 是 async。跨 `await` 持有全局 monkey patch 可能误捕其它面板的 listener，后续 close 时可能误删别人的 listener。

精确源码 backport 更接近 3.8.4 官方修复，风险更低。

## 为什么只在 3.8.3 启用

3.8.4 已经官方修复该问题。继续覆盖 3.8.4+ 的 Inspector handler 可能引入版本差异风险。

因此本模块严格限制：

```text
Editor.App.version === '3.8.3'
```

非 3.8.3 不注入 wrapper。

## 验证方式

### 静态验证

执行：

```bash
node scripts/verify-inspector-i18n-listener-leak.js
```

验证内容：

- 本机 3.8.3 原始 `asset.js` / `node.js` exact replacement 命中通过。
- 3.8.3 mock 会注入 wrapper。
- 3.8.4 mock 不注入 wrapper。
- `Editor.App.path = <CreatorRoot>\resources\app.asar` 时能正确定位原始 contribution 文件。

### 运行时验证

打开 debug 后启动 Creator 3.8.3，日志应出现：

```text
[creator-editor-fixes][inspector-i18n-listener-leak] 已注入 Inspector i18n 监听泄漏修复
[creator-editor-fixes][inspector-i18n-listener-leak] 已加载内存补丁 node.js
[creator-editor-fixes][inspector-i18n-listener-leak] 已加载内存补丁 asset.js
```

Creator Inspector 还会提示内置 handler 被插件覆盖：

```text
contributions\asset.js 被来自插件 creator-editor-fixes 的 ...\asset.js 覆盖了
contributions\node.js 被来自插件 creator-editor-fixes 的 ...\node.js 覆盖了
```

确认 wrapper 生效后，再反复切换：

- 普通节点。
- 带 `MeshRenderer + 多 Material` 的节点。
- Material asset。

观察 Editor 进程内存是否不再随切换次数线性上涨。
