# prefab-child-lock-persistence

## Supported behavior

In Cocos Creator 3.8.3, this fix observes `GeneralSceneFacade.changeNodeLock`, including its recursive (`loop`) form. The native `scene:set-property` pipeline cannot reliably persist the virtual editor lock, so the fix stores the final `LockedInEditor` state in the project `Editor.Profile`:

- locking a child persists `locked: true`;
- individually unlocking a child persists `locked: false`;
- recursive operations apply to the explicit targets and their descendants only;
- explicit `false` values are persisted;
- only top-level prefab instance roots and ordinary nodes are excluded, because Creator already serializes their editor lock into the scene;
- a nested prefab instance root (a prefab root that lives inside another prefab instance) is persisted like any other prefab child, keyed by its nearest prefab instance root owner and its `fileId` path;
- nested prefab children use their nearest prefab instance root;
- a top-level locked prefab root is not used to infer any child state during scene-ready.

The profile schema is `{ version: 1, scenes: { [sceneAssetUuid]: { [prefabRootFileId]: { [childFileIdPath]: boolean } } } }`. Keys are chosen to survive an editor restart: `sceneAssetUuid` is the scene asset uuid (stable), `prefabRootFileId` is the owning prefab instance's `PrefabInstance.fileId` (serialized in the scene, unique per instance, stable), and `childFileIdPath` is the `_prefab.fileId` chain from the owning prefab instance root down to the node, joined with `/`. The runtime node uuid is intentionally not used as a key because it is regenerated when the editor re-instantiates the prefab on a cold reload. Project Profile data is shared through SVN, so the project must use SVN sharing for this persistence to be shared between users.

Since `prefab-child-lock-persistence-v5`, the child key is the full `fileId` path rather than the node's own `fileId`. A single `fileId` is only unique inside the prefab asset that defines it, which is exactly why the engine models `TargetInfo.localID` as `string[]`: with two instances of the same nested prefab under one outer instance, their same-named children share one `fileId` and a single-level key would make their lock states collide. Records written by v4 (single-level keys) are still read as a fallback, so upgrading does not drop existing lock states.

## Safety and limitation

At scene-ready, matching records are restored individually through the original NodeManager lock operation. Restoration is guarded against persistence recursion, does not infer descendants from a root, and does not create separate undo commands. The `restoring` guard is raised before the profile read is awaited, so two overlapping `scene:ready` broadcasts cannot both enter restoration. The existing prefab-root-transform-override module is unchanged.

The hook is only installed when `Editor.App.version === '3.8.3'`; on any other version it logs one warning and installs nothing. If `GeneralSceneFacade.changeNodeLock` cannot be hooked, a single warning is printed instead of failing silently. When the extension is disabled or unloaded, `main.ts` calls `uninstallEditorHooks` through the scene script so the wrapper is removed from the scene process.

`cce.Node.changeNodeLock(uuid, locked, loop)` has no "do not record" parameter, so whether restoration marks the scene dirty depends on Creator's internal implementation (the scene package is shipped encrypted). This has not been observed in 3.8.3, but it is the first thing to re-check after an editor upgrade.

Profile writes are intentionally outside Creator's native scene undo stack. Undo/redo may change the live lock state, but does not automatically revert the matching Profile record; this behavior must be treated as a separate limitation and verified in the actual editor.

## Automated verification

```bash
npm run build
node scripts/verify-scene-fixes.js
```

The smoke test runs the built module against a fake `GeneralSceneFacade` / `cce` and asserts: single-level and multi-level child keys, no key collision between two instances of the same nested prefab, top-level prefab roots are not persisted, restoration hits both v5 path keys and v4 legacy keys, restoration does not write back to the profile, uninstall restores the original method, and the 3.8.3 version guard.

## Manual verification

1. Open a scene containing a prefab instance with prefab-derived children.
2. Lock an individual prefab child and reload the scene. Confirm it remains locked and the project Profile contains `true`.
3. Unlock that child, reload, and confirm the Profile contains `false` and it remains unlocked even if the prefab root is locked.
4. Test recursive lock and recursive unlock; confirm explicit targets and descendants are recorded, while roots and ordinary nodes are not.
5. Put two instances of the same nested prefab under one outer prefab instance, lock a child in only one of them, reload, and confirm the other instance is unaffected.
6. Confirm the project Profile change is shared through SVN.

No undo integration is provided for Profile persistence; verify undo behavior separately if required.
