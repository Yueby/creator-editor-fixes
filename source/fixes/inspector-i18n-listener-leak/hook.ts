import * as path from 'path';
import { debugLog } from '../../debug';
import { getEditorVersion, isSupportedEditorVersion, SUPPORTED_EDITOR_VERSION } from '../../editor-version';

const FIX_NAME = '[creator-editor-fixes][inspector-i18n-listener-leak]';

export function register(packageInfo: any): void {
    if (!isSupportedEditorVersion()) {
        debugLog(FIX_NAME, '跳过 Inspector i18n 监听泄漏修复', `version=${getEditorVersion() || 'unknown'} supported=${SUPPORTED_EDITOR_VERSION}`);
        return;
    }

    packageInfo.contributions = packageInfo.contributions || {};
    packageInfo.contributions.inspector = packageInfo.contributions.inspector || {};
    packageInfo.contributions.inspector.type = packageInfo.contributions.inspector.type || {};

    packageInfo.contributions.inspector.type.asset = path.join(__dirname, 'asset.js');
    packageInfo.contributions.inspector.type.node = path.join(__dirname, 'node.js');

    debugLog(FIX_NAME, '已注入 Inspector i18n 监听泄漏修复', packageInfo.contributions.inspector.type);
}
