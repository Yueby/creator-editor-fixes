import * as fs from 'fs';
import * as path from 'path';
import Module = require('module');
import { debugLog, debugWarn } from '../../debug';

const FIX_NAME = '[creator-editor-fixes][inspector-i18n-listener-leak]';

declare const Editor: any;

export interface Replacement {
    oldText: string;
    newText: string;
}

function normalizeCreatorRoot(appPath: string): string {
    const baseName = path.basename(appPath).toLowerCase();
    if (baseName === 'app.asar') return path.dirname(path.dirname(appPath));
    if (baseName === 'resources') return path.dirname(appPath);
    return appPath;
}

export function getCreatorRoot(): string | undefined {
    if (typeof Editor !== 'undefined' && Editor?.App?.path) return normalizeCreatorRoot(Editor.App.path);
    const resourcesPath = (process as any).resourcesPath;
    return resourcesPath ? normalizeCreatorRoot(resourcesPath) : undefined;
}

export function getOriginalContributionPath(fileName: string): string {
    const creatorRoot = getCreatorRoot();
    if (!creatorRoot) return fileName;

    return path.join(
        creatorRoot,
        'resources',
        'resources',
        '3d',
        'engine',
        'editor',
        'inspector',
        'contributions',
        fileName,
    );
}

export function applyExactReplacements(source: string, replacements: Replacement[], label: string): string | undefined {
    let patchedSource = source;

    for (const replacement of replacements) {
        const oldText = source.includes('\r\n') ? replacement.oldText.replace(/\n/g, '\r\n') : replacement.oldText;
        const newText = source.includes('\r\n') ? replacement.newText.replace(/\n/g, '\r\n') : replacement.newText;
        const count = source.split(oldText).length - 1;
        if (count !== 1) {
            debugWarn(FIX_NAME, `${label} 精确替换匹配次数异常`, `count=${count}`);
            return undefined;
        }

        patchedSource = patchedSource.replace(oldText, newText);
    }

    return patchedSource;
}

export function loadPatchedContribution(fileName: string, replacements: Replacement[]): any {
    const originalPath = getOriginalContributionPath(fileName);

    try {
        const source = fs.readFileSync(originalPath, 'utf8');
        const patchedSource = applyExactReplacements(source, replacements, fileName);
        if (!patchedSource) return require(originalPath);

        const patchedModule = new Module(originalPath, module.parent || module);
        patchedModule.filename = originalPath;
        patchedModule.paths = (Module as any)._nodeModulePaths(path.dirname(originalPath));
        (patchedModule as any)._compile(patchedSource, originalPath);

        debugLog(FIX_NAME, `已加载内存补丁 ${fileName}`);
        return patchedModule.exports;
    } catch (error) {
        debugWarn(FIX_NAME, `加载 ${fileName} 内存补丁失败`, error);
        return require(originalPath);
    }
}
