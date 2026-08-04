import { debugWarn } from './debug';

const PACKAGE_NAME = 'creator-editor-fixes';
const PROFILE_KEY = 'prefabChildLockStates';

interface PrefabChildLockState {
    version: 1;
    scenes: { [sceneUuid: string]: { [prefabRootFileId: string]: { [childFileId: string]: boolean } } };
}

let profileQueue: Promise<void> = Promise.resolve();

function emptyProfile(): PrefabChildLockState {
    return { version: 1, scenes: {} };
}

function validateProfile(value: any): PrefabChildLockState {
    const result = emptyProfile();
    if (!value || value.version !== 1 || !value.scenes || typeof value.scenes !== 'object') return result;
    for (const sceneUuid of Object.keys(value.scenes)) {
        const scene = value.scenes[sceneUuid];
        if (!scene || typeof scene !== 'object' || Array.isArray(scene)) continue;
        result.scenes[sceneUuid] = {};
        for (const rootFileId of Object.keys(scene)) {
            const root = scene[rootFileId];
            if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
            result.scenes[sceneUuid][rootFileId] = {};
            for (const childFileId of Object.keys(root)) {
                if (typeof root[childFileId] === 'boolean') result.scenes[sceneUuid][rootFileId][childFileId] = root[childFileId];
            }
        }
    }
    return result;
}

async function readPrefabChildLockStates(): Promise<PrefabChildLockState> {
    return validateProfile(await Editor.Profile.getProject(PACKAGE_NAME, PROFILE_KEY, 'project'));
}

function savePrefabChildLockStates(sceneUuid: string, changes: any): Promise<void> {
    if (typeof sceneUuid !== 'string' || !sceneUuid || !Array.isArray(changes)) return Promise.resolve();
    profileQueue = profileQueue.then(async () => {
        const profile = await readPrefabChildLockStates();
        const scene = profile.scenes[sceneUuid] || (profile.scenes[sceneUuid] = {});
        for (const change of changes) {
            if (!change || typeof change.prefabRootFileId !== 'string' || typeof change.childFileId !== 'string' || typeof change.locked !== 'boolean') continue;
            const root = scene[change.prefabRootFileId] || (scene[change.prefabRootFileId] = {});
            root[change.childFileId] = change.locked;
        }
        await Editor.Profile.setProject(PACKAGE_NAME, PROFILE_KEY, profile, 'project');
    }).catch((error) => {
        debugWarn(`[${PACKAGE_NAME}] 保存 prefab child lock 状态失败:`, error);
    });
    return profileQueue;
}

/** 调用场景脚本方法 */
async function executeSceneMethod(method: string, ...args: unknown[]): Promise<void> {
    await Editor.Message.request('scene', 'execute-scene-script', {
        name: PACKAGE_NAME,
        method,
        args,
    });
}

/** 安装场景侧编辑器内部 hook。 */
async function installSceneHooks(): Promise<boolean> {
    try {
        const isReady = await Editor.Message.request('scene', 'query-is-ready') as boolean;
        if (!isReady) return false;

        await executeSceneMethod('installEditorHooks');
        return true;
    } catch (error) {
        debugWarn(`[${PACKAGE_NAME}] 安装场景 hook 失败:`, error);
        return false;
    }
}

/** 设置场景 ready 标记。 */
async function setSceneReadyState(isReady: boolean): Promise<void> {
    try {
        await executeSceneMethod('setSceneReadyState', isReady);
    } catch (_error) {
        // 场景关闭过程中 scene 进程可能已经不可用，忽略即可。
    }
}

/** 卸载场景侧 hook，避免扩展被禁用/卸载后 patch 残留在 scene 进程里。 */
async function uninstallSceneHooks(): Promise<void> {
    try {
        await executeSceneMethod('setSceneReadyState', false);
        await executeSceneMethod('uninstallEditorHooks');
    } catch (error) {
        debugWarn(`[${PACKAGE_NAME}] 卸载场景 hook 失败:`, error);
    }
}

export const methods: { [key: string]: (...args: any[]) => any } = {
    async getPrefabChildLockStates() {
        return readPrefabChildLockStates();
    },
    savePrefabChildLockStates,
    /** scene:ready 广播 */
    async onSceneReady() {
        if (await installSceneHooks()) {
            await setSceneReadyState(true);
        }
    },

    /** scene:close 广播 */
    async onSceneClose() {
        await setSceneReadyState(false);
    },
};

/** 扩展启动时触发 */
export function load() {
    installSceneHooks().then((installed) => {
        if (installed) setSceneReadyState(true);
    });
}

/** 扩展卸载时触发 */
export async function unload() {
    await uninstallSceneHooks();
}
