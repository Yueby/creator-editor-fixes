import * as prefabRootTransformOverride from './fixes/prefab-root-transform-override';
import * as prefabChildLockPersistence from './fixes/prefab-child-lock-persistence';
import * as prefabActiveOverrideSync from './fixes/prefab-active-override-sync';

export async function installEditorHooks(): Promise<void> {
    await prefabRootTransformOverride.installEditorHooks();
    await prefabChildLockPersistence.installEditorHooks();
    await prefabActiveOverrideSync.installEditorHooks();
}

export async function setSceneReadyState(isReady: boolean): Promise<void> {
    await prefabRootTransformOverride.setSceneReadyState(isReady);
    await prefabChildLockPersistence.setSceneReadyState(isReady);
    await prefabActiveOverrideSync.setSceneReadyState(isReady);
}

export async function uninstallEditorHooks(): Promise<void> {
    await prefabActiveOverrideSync.uninstallEditorHooks();
    await prefabChildLockPersistence.uninstallEditorHooks();
    await prefabRootTransformOverride.uninstallEditorHooks();
}

export const methods: { [key: string]: (...args: any[]) => any } = {
    installEditorHooks,
    setSceneReadyState,
    uninstallEditorHooks,
};

export function unload(): void {
    prefabActiveOverrideSync.unload();
    prefabChildLockPersistence.unload();
    prefabRootTransformOverride.unload();
}
