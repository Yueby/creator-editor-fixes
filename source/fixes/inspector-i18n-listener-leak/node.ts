import { loadPatchedContribution, Replacement } from './patcher';

const replacements: Replacement[] = [
    {
        oldText: `            Elements.node.i18nChangeBind = Elements.node.i18nChange.bind(panel);
            Editor.Message.addBroadcastListener('i18n:change', Elements.node.i18nChangeBind);`,
        newText: `            panel.i18nChangeBind = Elements.node.i18nChange.bind(panel);
            Editor.Message.addBroadcastListener('i18n:change', panel.i18nChangeBind);`,
    },
    {
        oldText: `        close() {
            Editor.Message.removeBroadcastListener('i18n:change', Elements.node.i18nChangeBind);
        },`,
        newText: `        close() {
            const panel = this;

            Editor.Message.removeBroadcastListener('i18n:change', panel.i18nChangeBind);
        },`,
    },
];

export = loadPatchedContribution('node.js', replacements);
