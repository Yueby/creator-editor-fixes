# prefab-child-lock-persistence

## Supported behavior

In Cocos Creator 3.8.3, this fix observes `GeneralSceneFacade.changeNodeLock`, including its recursive (`loop`) form. The native `scene:set-property` pipeline cannot reliably persist the virtual editor lock, so the fix stores the final `LockedInEditor` state in the project `Editor.Profile`:

- locking a child persists `locked: true`;
- individually unlocking a child persists `locked: false`;
- recursive operations apply to the explicit targets and their descendants only;
- explicit `false` values are persisted;
- only top-level prefab instance roots and ordinary nodes are excluded, because Creator already serializes their editor lock into the scene;
- a nested prefab instance root (a prefab root that lives inside another prefab instance) is persisted like any other prefab child, keyed by its nearest prefab instance root owner and its own `fileId`;
- nested prefab children use their nearest prefab instance root;
- a top-level locked prefab root is not used to infer any child state during scene-ready.

The profile schema is `{ version: 1, scenes: { [sceneAssetUuid]: { [prefabRootFileId]: { [childFileId]: boolean } } } }`. Keys are chosen to survive an editor restart: `sceneAssetUuid` is the scene asset uuid (stable), `prefabRootFileId` is the owning prefab instance's `PrefabInstance.fileId` (serialized in the scene, unique per instance, stable), and `childFileId` is the child's `_prefab.fileId` (defined in the prefab asset, stable). The runtime node uuid is intentionally not used as a key because it is regenerated when the editor re-instantiates the prefab on a cold reload. Project Profile data is shared through SVN, so the project must use SVN sharing for this persistence to be shared between users.

## Safety and limitation

At scene-ready, matching records are restored individually through the original NodeManager lock operation. Restoration is guarded against persistence recursion, does not infer descendants from a root, and does not create separate undo commands. The existing prefab-root-transform-override module is unchanged.

Profile writes are intentionally outside Creator's native scene undo stack. Undo/redo may change the live lock state, but does not automatically revert the matching Profile record; this behavior must be treated as a separate limitation and verified in the actual editor.

## Manual verification

1. Open a scene containing a prefab instance with prefab-derived children.
2. Lock an individual prefab child and reload the scene. Confirm it remains locked and the project Profile contains `true`.
3. Unlock that child, reload, and confirm the Profile contains `false` and it remains unlocked even if the prefab root is locked.
4. Test recursive lock and recursive unlock; confirm explicit targets and descendants are recorded, while roots and ordinary nodes are not.
5. Confirm the project Profile change is shared through SVN.

No undo integration is provided for Profile persistence; verify undo behavior separately if required.
