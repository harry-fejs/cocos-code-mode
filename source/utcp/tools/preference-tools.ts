import { utcpTool } from '../decorators';
// @ts-ignore
import packageJSON from '../../../package.json';

// Editor preference tools — read/write persistent config via Editor.Profile.
// Scoped to the ccp3x extension's own profile keys. This is NOT project
// settings (that lives in projectManage get/set); these are editor-side
// persistence of bridge behavior (port, tool profile, envelope).

const KNOWN_KEYS: Record<string, string> = {
    serverPort: 'number — UTCP HTTP server port (0 = auto)',
    toolProfile: 'string — "core" | "full" | "custom"',
    enabledTools: 'string[] — extra tools exposed when profile=core/custom',
    disabledTools: 'string[] — tools hidden even in profile=full',
    responseEnvelope: 'boolean — wrap responses in {ok,callId,data,refs} envelope',
    utcpConfigPath: 'string — path to ~/.utcp_config.json',
};

export class PreferenceTools {

    @utcpTool(
        'getEditorPreference',
        'Read one or all ccp3x persistent preferences (Editor.Profile). Omit key to list all known keys.',
        {
            type: 'object',
            properties: {
                key: { type: 'string', description: `Preference key. Known: ${Object.keys(KNOWN_KEYS).join(', ')}. Omit to list all.` },
            },
        },
        {
            type: 'object',
            properties: {
                key: { type: 'string' },
                value: {},
                all: { type: 'object', description: 'Present when key omitted: every known preference' },
            },
            required: [],
        },
        'GET',
        ['preference', 'config', 'setting', 'read', 'editor']
    )
    async getEditorPreference(args: { key?: string }): Promise<{ key?: string, value?: any, all?: Record<string, any> }> {
        if (args.key) {
            const value = await Editor.Profile.getConfig(packageJSON.name, args.key);
            return { key: args.key, value: value === undefined ? null : value };
        }
        const all: Record<string, any> = {};
        for (const key of Object.keys(KNOWN_KEYS)) {
            const value = await Editor.Profile.getConfig(packageJSON.name, key);
            all[key] = value === undefined ? null : value;
        }
        return { all };
    }

    @utcpTool(
        'setEditorPreference',
        'Write a ccp3x persistent preference (Editor.Profile). Known keys are type-validated.',
        {
            type: 'object',
            properties: {
                key: { type: 'string', description: `Preference key. Known: ${Object.keys(KNOWN_KEYS).join(', ')}` },
                value: { description: 'New value. Must match the key type.' },
            },
            required: ['key', 'value'],
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                key: { type: 'string' },
                value: {},
            },
            required: ['success', 'key'],
        },
        'POST',
        ['preference', 'config', 'setting', 'write', 'editor']
    )
    async setEditorPreference(args: { key: string, value: any }): Promise<{ success: boolean, key: string, value: any }> {
        if (!args.key) throw new Error('setEditorPreference requires key');
        // Light type validation for known keys
        if (args.key in KNOWN_KEYS) {
            const expected = KNOWN_KEYS[args.key].split(' ')[0];
            if (expected === 'number' && typeof args.value !== 'number') throw new Error(`Key '${args.key}' expects a number`);
            if (expected === 'string' && typeof args.value !== 'string') throw new Error(`Key '${args.key}' expects a string`);
            if (expected === 'boolean' && typeof args.value !== 'boolean') throw new Error(`Key '${args.key}' expects a boolean`);
            if (expected === 'string[]' && !Array.isArray(args.value)) throw new Error(`Key '${args.key}' expects a string array`);
        }
        await Editor.Profile.setConfig(packageJSON.name, args.key, args.value);
        return { success: true, key: args.key, value: args.value };
    }
}
