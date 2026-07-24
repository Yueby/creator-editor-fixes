import * as path from 'path';
import { debugLog } from '../../debug';

const FIX_NAME = '[creator-editor-fixes][inspector-i18n-listener-leak]';

declare const Editor: any;

export function register(packageInfo: any): void {
    const version = typeof Editor !== 'undefined' ? Editor?.App?.version : undefined;
    if (version !== '3.8.3') {
        debugLog(FIX_NAME, '跳过 Inspector i18n 监听泄漏修复', `version=${version || 'unknown'}`);
        return;
    }

    packageInfo.contributions = packageInfo.contributions || {};
    packageInfo.contributions.inspector = packageInfo.contributions.inspector || {};
    packageInfo.contributions.inspector.type = packageInfo.contributions.inspector.type || {};

    packageInfo.contributions.inspector.type.asset = path.join(__dirname, 'asset.js');
    packageInfo.contributions.inspector.type.node = path.join(__dirname, 'node.js');

    debugLog(FIX_NAME, '已注入 Inspector i18n 监听泄漏修复', packageInfo.contributions.inspector.type);
}
