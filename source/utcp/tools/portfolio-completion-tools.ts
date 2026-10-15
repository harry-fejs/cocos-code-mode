import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { UiTools } from './ui-tools';
import { AssetTools } from './asset-tools';

const MAX_VISIBLE_ITEMS = 20;

export class PortfolioCompletionTools {
    @utcpTool('assetSceneUsageAudit', 'Audit bounded scene-root reachability using Creator asset graph v4 evidence.', {
        type: 'object', additionalProperties: false,
        properties: {
            assetPath: { type: 'string', minLength: 1, maxLength: 256 },
            maxAssets: { type: 'integer', minimum: 1, maximum: 128, default: 64 },
            maxGraphAssets: { type: 'integer', minimum: 1, maximum: 5000, default: 5000 },
            sceneReferences: { type: 'array', minItems: 1, maxItems: 128, items: InstanceReferenceSchema },
        },
    }, {
        type: 'object', properties: {
            graphVersion: { type: 'string' }, complete: { type: 'boolean' }, roots: { type: 'array' },
            graphAssets: { type: 'integer' }, graphEdges: { type: 'integer' }, candidates: { type: 'array' },
            referenceEvidence: { type: 'array' }, dynamicLoadCaveat: { type: 'string' },
        }, required: ['graphVersion', 'complete', 'roots', 'graphAssets', 'graphEdges', 'candidates', 'referenceEvidence', 'dynamicLoadCaveat'],
    }, 'GET', ['asset', 'scene', 'usage', 'audit'])
    async assetSceneUsageAudit(args: { assetPath?: string, maxAssets?: number, maxGraphAssets?: number, sceneReferences?: IInstanceReference[] } = {}): Promise<Record<string, unknown>> {
        const result = await new AssetTools().assetUsageAnalyze({
            assetPath: args.assetPath,
            maxAssets: args.maxAssets,
            maxGraphAssets: args.maxGraphAssets,
            rootReferences: args.sceneReferences,
        });
        return result;
    }


    @utcpTool('uiVirtualListCreate', 'Create a bounded ScrollView-backed virtual-list shell and materialize only the declared visible item window.', {
        type: 'object', additionalProperties: false,
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 128 }, parentReference: InstanceReferenceSchema,
            itemCount: { type: 'integer', minimum: 0, maximum: 100000 },
            visibleItems: { type: 'integer', minimum: 1, maximum: MAX_VISIBLE_ITEMS },
            startIndex: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
        }, required: ['itemCount', 'visibleItems'],
    }, {
        type: 'object', properties: { reference: { type: 'object' }, viewport: { type: 'object' }, content: { type: 'object' }, itemReferences: { type: 'array' }, itemCount: { type: 'integer' }, instantiatedItems: { type: 'integer' }, virtualized: { type: 'boolean', const: false }, startIndex: { type: 'integer' }, nextIndex: { type: ['integer', 'null'] }, runtimeRecyclingBound: { type: 'boolean', const: false } },
        required: ['reference', 'viewport', 'content', 'itemReferences', 'itemCount', 'instantiatedItems', 'virtualized', 'startIndex', 'nextIndex', 'runtimeRecyclingBound'],
    }, 'POST', ['ui', 'virtual', 'list', 'create'])
    async uiVirtualListCreate(args: { name?: string, parentReference?: IInstanceReference, itemCount: number, visibleItems: number, startIndex?: number }): Promise<Record<string, unknown>> {
        if (!args || !Number.isInteger(args.itemCount) || args.itemCount < 0 || args.itemCount > 100000
            || !Number.isInteger(args.visibleItems) || args.visibleItems < 1 || args.visibleItems > MAX_VISIBLE_ITEMS) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `itemCount must be an integer from 0 to 100000 and visibleItems from 1 to ${MAX_VISIBLE_ITEMS}.` });
        const startIndex = args.startIndex ?? 0;
        if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > args.itemCount) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'startIndex must be an integer within 0..itemCount.' });
        const ui = new UiTools();
        const list = await ui.uiCreateScrollView({ name: args.name ?? 'VirtualList', parentReference: args.parentReference });
        const materialized = Math.min(args.itemCount - startIndex, args.visibleItems);
        const itemReferences: IInstanceReference[] = [];
        for (let index = 0; index < materialized; index++) {
            const itemIndex = startIndex + index;
            const item = await ui.createLabel({ name: `Item-${itemIndex}`, text: String(itemIndex), parentReference: list.content });
            itemReferences.push(item.reference);
        }
        await Editor.Message.request('scene', 'snapshot');
        return { ...list, itemReferences, itemCount: args.itemCount, instantiatedItems: materialized, startIndex, nextIndex: startIndex + materialized < args.itemCount ? startIndex + materialized : null, virtualized: false, runtimeRecyclingBound: false };
    }

    @utcpTool('uiFormValidationBind', 'Create a bounded input form and return explicit validation metadata.', {
        type: 'object', additionalProperties: false,
        properties: {
            label: { type: 'string', minLength: 1, maxLength: 128 },
            placeholder: { type: 'string', maxLength: 256 },
            required: { type: 'boolean' },
            minLength: { type: 'integer', minimum: 0, maximum: 256 },
            name: { type: 'string', minLength: 1, maxLength: 128 },
            parentReference: InstanceReferenceSchema,
        },
        required: ['label'],
    }, {
        type: 'object', properties: { form: { type: 'object' }, rules: { type: 'object' }, focusOrder: { type: 'array' }, runtimeValidationBound: { type: 'boolean', const: false } },
        required: ['form', 'rules', 'focusOrder', 'runtimeValidationBound'],
    }, 'POST', ['ui', 'form', 'validation', 'bind'])
    async uiFormValidationBind(args: { label: string, placeholder?: string, required?: boolean, minLength?: number, name?: string, parentReference?: IInstanceReference }): Promise<Record<string, unknown>> {
        if (!args || typeof args.label !== 'string' || args.label.length < 1 || args.label.length > 128
            || args.placeholder !== undefined && (typeof args.placeholder !== 'string' || args.placeholder.length > 256)
            || args.name !== undefined && (typeof args.name !== 'string' || args.name.length < 1 || args.name.length > 128)
            || args.required !== undefined && typeof args.required !== 'boolean'
            || args.minLength !== undefined && (!Number.isInteger(args.minLength) || args.minLength < 0 || args.minLength > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide schema-bounded form text, boolean required and integer minLength0..256.' });
        const required = args.required ?? true;
        const minLength = args.minLength ?? 0;
        if (minLength > 0 && !required) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'minLength requires required=true.' });
        const form = await new UiTools().uiCreateInputForm({ label: args.label, placeholder: args.placeholder, name: args.name, parentReference: args.parentReference });
        return { form, rules: { required, minLength, inputReference: form.input }, focusOrder: form.focusOrder, runtimeValidationBound: false };
    }
}
