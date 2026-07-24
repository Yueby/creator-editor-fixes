import { loadPatchedContribution, Replacement } from './patcher';

const replacements: Replacement[] = [
    {
        oldText: `            Elements.panel.i18nChangeBind = Elements.panel.i18nChange.bind(panel);
            Editor.Message.addBroadcastListener('i18n:change', Elements.panel.i18nChangeBind);`,
        newText: `            panel.i18nChangeBind = Elements.panel.i18nChange.bind(panel);
            Editor.Message.addBroadcastListener('i18n:change', panel.i18nChangeBind);`,
    },
    {
        oldText: `            Editor.Message.removeBroadcastListener('asset-db:asset-change', panel.__assetChanged__);

            delete panel.history;`,
        newText: `            Editor.Message.removeBroadcastListener('i18n:change', panel.i18nChangeBind);
            Editor.Message.removeBroadcastListener('asset-db:asset-change', panel.__assetChanged__);

            delete panel.history;`,
    },
];

export = loadPatchedContribution('asset.js', replacements);
