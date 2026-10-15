import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { IProperty } from '@cocos/creator-types/editor/packages/scene/@types/public';
import { finalizeUiLayoutReport } from '../../ui-layout-report';
import type { LayoutReport, LayoutReportRequest, LayoutReportResult } from '../../ui-layout-report';
import type { UiSafeAreaInspectRequest, UiSafeAreaInspectResult } from '../../ui-safe-area-inspect';
import { isCandidateRequest } from '../../ui-layout-validate';
import type { UiLayoutValidateRequest, UiLayoutValidateResult } from '../../ui-layout-validate';
import type { UiAccessibilityAuditRequest, UiAccessibilityAuditResult } from '../../ui-accessibility-audit';
import { calculateLayoutAlignment, LayoutAlignAxis, LayoutAlignEdge, LayoutAlignmentUpdate, LayoutAlignOperation } from '../../ui-layout-align';
import { isUiLayoutGeometry } from '../../ui-layout-inspect';
import type { UiReflowResult } from '../../ui-reflow';
import { isUiReflowResult } from '../../ui-reflow';

// UI prefab paths — Cocos Creator 3.x internal UI prefabs
const UI_PREFABS: Record<string, string> = {
    Canvas: 'db://internal/default_ui/Canvas.prefab',
    Label: 'db://internal/default_ui/Label.prefab',
    Button: 'db://internal/default_ui/Button.prefab',
    Sprite: 'db://internal/default_ui/Sprite.prefab',
    Widget: 'db://internal/default_ui/Widget.prefab',
    ScrollView: 'db://internal/default_ui/ScrollView.prefab',
    Toggle: 'db://internal/default_ui/Toggle.prefab',
    ProgressBar: 'db://internal/default_ui/ProgressBar.prefab',
    Slider: 'db://internal/default_ui/Slider.prefab',
    EditBox: 'db://internal/default_ui/EditBox.prefab',
    Layout: 'db://internal/default_ui/Layout.prefab',
    Graphics: 'db://internal/default_ui/Graphics.prefab',
    Mask: 'db://internal/default_ui/Mask.prefab',
    PageView: 'db://internal/default_ui/PageView.prefab',
    SafeArea: 'db://internal/default_ui/SafeArea.prefab',
};

interface SceneNodeDump {
    name?: string | { value?: string };
    children?: Array<{ uuid?: string, value?: { uuid?: string } }>;
    __comps__?: Array<{ type?: string, value?: Record<string, any> }>;
    position?: { value?: { x?: number, y?: number, z?: number } };
    active?: { value?: boolean } | boolean;
    uuid?: string;
    parent?: { value?: { uuid?: string }, uuid?: string };
}

interface UiLayoutNode {
    reference: IInstanceReference;
    name: string;
    active: boolean;
    position: { x: number, y: number, z: number };
    size: { width: number, height: number } | null;
    anchor: { x: number, y: number } | null;
    worldRect: { x: number, y: number, width: number, height: number } | null;
    components: string[];
}
async function ensureSceneComponents(uuid: string, components: string[]): Promise<void> {
    for (const component of [...new Set(components)]) {
        const raw = await Editor.Message.request('scene', 'query-node', uuid);
        const dump = raw && typeof raw === 'object' ? raw as unknown as SceneNodeDump : null;
        const existing = new Set((dump?.__comps__ ?? []).map((item) => item.type).filter((type): type is string => typeof type === 'string'));
        if (existing.has(component)) continue;
        await Editor.Message.request('scene', 'create-component', { uuid, component });
    }
}


export class UiTools {

    @utcpTool(
        'createUiNode',
        'Create a UI node from Cocos internal prefab templates (Canvas, Label, Button, Sprite, Widget, ScrollView, Toggle, ProgressBar, Slider, EditBox, Layout, Graphics, Mask, PageView, SafeArea).',
        {
            type: 'object',
            properties: {
                uiType: { type: 'string', enum: Object.keys(UI_PREFABS), description: 'UI component type to create' },
                name: { type: 'string', description: 'Node name (defaults to uiType)' },
                parentReference: InstanceReferenceSchema,
            },
            required: ['uiType'],
        },
        { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] },
        'POST',
        ['ui', 'create', 'canvas', 'label', 'button', 'sprite', 'widget', '2d', 'panel']
    )
    async createUiNode(args: { uiType: string, name?: string, parentReference?: IInstanceReference }): Promise<{ reference: IInstanceReference }> {
        const prefabUrl = UI_PREFABS[args.uiType];
        if (!prefabUrl) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Unknown UI type: ${args.uiType}. Available: ${Object.keys(UI_PREFABS).join(', ')}` });
        }
        const nativeComponent = ({
            Canvas: 'cc.Canvas', Label: 'cc.Label', Button: 'cc.Button', Sprite: 'cc.Sprite',
            ScrollView: 'cc.ScrollView', EditBox: 'cc.EditBox', Widget: 'cc.UITransform',
        } as Record<string, string>)[args.uiType];
        let assetUuid: string | null;
        let sceneRoot: { uuid?: string } | null;
        try {
            [assetUuid, sceneRoot] = await Promise.all([
                Editor.Message.request('asset-db', 'query-uuid', prefabUrl),
                args.parentReference?.id ? Promise.resolve(null) : Editor.Message.request('scene', 'query-node-tree'),
            ]) as [string | null, { uuid?: string } | null];
        } catch (error: unknown) {
            throw new ToolError({ code: 'UI_CREATE_QUERY_FAILED', status: 502, message: `Could not resolve the ${args.uiType} creation target.`, details: { cause: error instanceof Error ? error.message : String(error) }, recovery: 'Retry after the Creator scene and asset database are ready.' });
        }
        const parent = args.parentReference?.id || sceneRoot?.uuid;
        if (!parent) throw new ToolError({ code: 'SCENE_NOT_READY', status: 409, message: 'A scene root or parentReference is required to create a UI node.', recovery: 'Open a scene or pass a valid parentReference.' });
        const options: Record<string, unknown> = { name: args.name || args.uiType, parent };
        let result: unknown;
        try {
            result = await Editor.Message.request('scene', 'create-node', options);
        } catch (error: unknown) {
            throw new ToolError({ code: 'UI_CREATE_FAILED', status: 502, message: `Creator could not create ${args.uiType}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
        }
        const nodeUuid = Array.isArray(result) ? result[0] : result;
        if (typeof nodeUuid !== 'string' || !nodeUuid) throw new ToolError({ code: 'UI_CREATE_INVALID_RESPONSE', status: 502, message: `Creator returned no UUID for the ${args.uiType} node.` });
        try {
            if (!assetUuid) {
                if (!nativeComponent) throw new ToolError({ code: 'UNSUPPORTED_EDITOR_API', status: 422, message: `UI prefab not found at ${prefabUrl} and no native fallback is defined for ${args.uiType}.` });
                await ensureSceneComponents(nodeUuid, [nativeComponent, 'cc.UITransform']);
            }
            await Editor.Message.request('scene', 'snapshot');
            const readBack = await this.queryNodeDump(nodeUuid);
            if (!readBack || this.unwrapValue(readBack.uuid) !== nodeUuid) throw new Error('query-node did not confirm the created node UUID');
            if (nativeComponent) {
                const types = new Set((readBack.__comps__ ?? []).map((component) => component.type).filter((type): type is string => typeof type === 'string'));
                if (!types.has(nativeComponent)) throw new Error(`query-node did not confirm component ${nativeComponent}`);
            }
            return { reference: { id: nodeUuid, type: 'cc.Node' } };
        } catch (error: unknown) {
            const rollback = await this.rollbackNode(nodeUuid);
            if (error instanceof ToolError) throw error;
            throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 502, message: `createUiNode did not confirm ${args.uiType} ${nodeUuid}${rollback ? `; rollback failed: ${rollback}` : '; created node was rolled back'}.`, details: { createdNodeId: nodeUuid, cause: error instanceof Error ? error.message : String(error) }, recovery: rollback ? `Delete node ${nodeUuid} manually before retrying.` : 'Retry the creation after the scene is ready.' });
        }
    }

    @utcpTool(
        'createCanvas',
        'Create a Canvas UI root with cc.Canvas and cc.UITransform, then verify its node identity.',
        { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, parentReference: InstanceReferenceSchema } },
        { type: 'object', additionalProperties: false, properties: { canvasUuid: { type: 'string' }, reference: InstanceReferenceSchema }, required: ['canvasUuid', 'reference'] },
        'POST', ['ui', 'canvas', 'create', '2d']
    )
    async createCanvas(args: { name?: string, parentReference?: IInstanceReference } = {}): Promise<{ canvasUuid: string, reference: IInstanceReference }> {
        const { reference } = await this.createUiNode({ uiType: 'Canvas', name: args.name ?? 'Canvas', parentReference: args.parentReference });
        return { canvasUuid: reference.id, reference };
    }

    @utcpTool(
        'createLabel',
        'Create a UI Label node with optional text, font size, and color.',
        {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Node name (default "Label")' },
                text: { type: 'string', description: 'Label text content' },
                fontSize: { type: 'number', description: 'Font size (default 20)' },
                color: { type: 'string', description: 'Text color hex, e.g. "#FFFFFF"' },
                parentReference: InstanceReferenceSchema,
            },
        },
        { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] },
        'POST',
        ['ui', 'label', 'text', 'create', '2d']
    )
    async createLabel(args: { name?: string, text?: string, fontSize?: number, color?: string, parentReference?: IInstanceReference }): Promise<{ reference: IInstanceReference }> {
        const { reference } = await this.createUiNode({ uiType: 'Label', name: args.name || 'Label', parentReference: args.parentReference });
        if (args.text === undefined && args.fontSize === undefined && args.color === undefined) return { reference };
        const componentPath = await this.componentPath(reference.id, 'cc.Label');
        const properties: Array<{ path: string, dump: IProperty, expected: unknown }> = [];
        if (args.text !== undefined) properties.push({ path: `${componentPath}.string`, dump: { value: args.text, type: 'cc.String' }, expected: args.text });
        if (args.fontSize !== undefined) properties.push({ path: `${componentPath}.fontSize`, dump: { value: args.fontSize, type: 'cc.Integer' }, expected: args.fontSize });
        if (args.color !== undefined) properties.push({ path: `${componentPath}.color`, dump: { value: args.color, type: 'cc.Color' }, expected: args.color });
        try {
            for (const property of properties) {
                const accepted = await Editor.Message.request('scene', 'set-property', { uuid: reference.id, path: property.path, dump: property.dump });
                if (accepted === false) throw new Error(`Creator refused ${property.path}`);
            }
            const dump = await this.queryNodeDump(reference.id);
            const label = dump?.__comps__?.find((component) => component.type === 'cc.Label')?.value;
            for (const property of properties) {
                const field = property.path.slice(property.path.lastIndexOf('.') + 1);
                const actual = label && field in label ? this.unwrapValue(label[field]) : undefined;
                if (JSON.stringify(actual) !== JSON.stringify(property.expected)) throw new Error(`read-back mismatch at ${field}`);
            }
            await Editor.Message.request('scene', 'snapshot');
            return { reference };
        } catch (error: unknown) {
            const rollback = await this.rollbackNode(reference.id);
            throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 502, message: `createLabel configuration was not confirmed for ${reference.id}${rollback ? `; rollback failed: ${rollback}` : '; created node was rolled back'}.`, details: { createdNodeId: reference.id, cause: error instanceof Error ? error.message : String(error) }, recovery: rollback ? `Delete node ${reference.id} manually before retrying.` : 'Retry after the scene is ready.' });
        }
    }

    @utcpTool(
        'createButton',
        'Create a UI Button node with optional label text.',
        {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Node name (default "Button")' },
                text: { type: 'string', description: 'Button label text' },
                parentReference: InstanceReferenceSchema,
            },
        },
        { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] },
        'POST',
        ['ui', 'button', 'create', '2d', 'interactive']
    )
    async createButton(args: { name?: string, text?: string, parentReference?: IInstanceReference }): Promise<{ reference: IInstanceReference }> {
        const { reference } = await this.createUiNode({ uiType: 'Button', name: args.name || 'Button', parentReference: args.parentReference });

        // Button prefab has a child Label node — set its text. No swallow: a requested
        // label that was not applied must fail loudly, otherwise the agent believes
        // the button reads its text (docs §2 "trả sai còn tệ hơn ném lỗi").
        if (args.text !== undefined) {
            try {
                const node = await this.queryNodeDump(reference.id);
                let labelChildUuid = await this.findNamedChild(node, 'Label');
                if (!labelChildUuid) {
                    labelChildUuid = await this.createNativeLabelChild(reference.id);
                }
                if (!labelChildUuid) {
                    const rbErr = await this.rollbackNode(reference.id);
                    throw new ToolError({
                        code: 'PARTIAL_MUTATION',
                        status: 500,
                        message: `createButton: no Label child on ${reference.id} — text "${args.text}" was not applied${rbErr ? `; rollback FAILED (${rbErr}) — delete node ${reference.id} before retrying` : '; created node was rolled back, safe to retry'}`,
                        details: { createdNodeId: reference.id, reason: 'no Label child' },
                        recovery: 'Node was rolled back, safe to retry; or query-node to verify structure',
                    });
                }
                const labelPath = await this.componentPath(labelChildUuid, 'cc.Label');
                const ok = await Editor.Message.request('scene', 'set-property', { uuid: labelChildUuid, path: `${labelPath}.string`, dump: { value: args.text, type: 'cc.String' } }) as boolean;
                if (ok === false) {
                    const rbErr = await this.rollbackNode(reference.id);
                    throw new ToolError({
                        code: 'PARTIAL_MUTATION',
                        message: `createButton: set-property refused for label text on ${labelChildUuid} (button ${reference.id})${rbErr ? `; rollback FAILED (${rbErr}) — delete node ${reference.id} before retrying` : '; button was rolled back, safe to retry'}`,
                        details: { createdNodeId: reference.id, labelChildUuid },
                        recovery: 'Button was rolled back, safe to retry',
                    });
                }
                await Editor.Message.request('scene', 'snapshot');
            } catch (err: unknown) {
                if (err instanceof ToolError) throw err;
                const rbErr = await this.rollbackNode(reference.id);
                const errorMessage = err instanceof Error ? err.message : String(err);
                throw new ToolError({
                    code: 'PARTIAL_MUTATION',
                    status: 500,
                    message: `createButton: follow-up IPC failed for button ${reference.id} (${errorMessage})${rbErr ? `; rollback FAILED (${rbErr}) — delete node ${reference.id} before retrying` : '; created node was rolled back, safe to retry'}`,
                    details: { createdNodeId: reference.id, error: errorMessage },
                    recovery: 'Button was rolled back, safe to retry',
                });
            }
        }

        return { reference };
    }

    @utcpTool(
        'createSprite',
        'Create a UI Sprite node, optionally assigning a SpriteFrame asset.',
        {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Node name (default "Sprite")' },
                spriteFrameUuid: { type: 'string', description: 'Optional SpriteFrame asset uuid to assign' },
                parentReference: InstanceReferenceSchema,
            },
        },
        { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] },
        'POST',
        ['ui', 'sprite', 'image', 'create', '2d']
    )
    async createSprite(args: { name?: string, spriteFrameUuid?: string, parentReference?: IInstanceReference }): Promise<{ reference: IInstanceReference }> {
        const { reference } = await this.createUiNode({ uiType: 'Sprite', name: args.name || 'Sprite', parentReference: args.parentReference });
        if (!args.spriteFrameUuid) return { reference };
        try {
            const componentPath = await this.componentPath(reference.id, 'cc.Sprite');
            const accepted = await Editor.Message.request('scene', 'set-property', {
                uuid: reference.id,
                path: `${componentPath}.spriteFrame`,
                dump: { value: { uuid: args.spriteFrameUuid }, type: 'cc.SpriteFrame' },
            });
            if (accepted === false) throw new Error('Creator refused spriteFrame assignment');
            const dump = await this.queryNodeDump(reference.id);
            const sprite = dump?.__comps__?.find((component) => component.type === 'cc.Sprite')?.value;
            const spriteFrame = sprite && 'spriteFrame' in sprite ? this.unwrapValue(sprite.spriteFrame) : undefined;
            const assignedUuid = spriteFrame && typeof spriteFrame === 'object' && 'uuid' in spriteFrame && typeof spriteFrame.uuid === 'string' ? spriteFrame.uuid : undefined;
            if (assignedUuid !== args.spriteFrameUuid) throw new Error('spriteFrame read-back mismatch');
            await Editor.Message.request('scene', 'snapshot');
            return { reference };
        } catch (error: unknown) {
            const rollback = await this.rollbackNode(reference.id);
            throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 502, message: `createSprite configuration was not confirmed for ${reference.id}${rollback ? `; rollback failed: ${rollback}` : '; created node was rolled back'}.`, details: { createdNodeId: reference.id, spriteFrameUuid: args.spriteFrameUuid, cause: error instanceof Error ? error.message : String(error) }, recovery: rollback ? `Delete node ${reference.id} manually before retrying.` : 'Verify the SpriteFrame UUID and retry.' });
        }
    }
    @utcpTool('spriteFrameAssign', 'Assign or clear a SpriteFrame on an existing Sprite node with authoritative read-back.', { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, spriteFrameReference: InstanceReferenceSchema }, required: ['nodeReference'] }, { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, spriteFrameReference: { type: ['object', 'null'] }, changed: { type: 'boolean' } }, required: ['nodeReference', 'spriteFrameReference', 'changed'] }, 'POST', ['ui', 'sprite', 'frame', 'assign', 'image'])
    async spriteFrameAssign(args: { nodeReference: IInstanceReference, spriteFrameReference?: IInstanceReference }): Promise<{ nodeReference: IInstanceReference, spriteFrameReference: IInstanceReference | null, changed: boolean }> {
        const nodeId = args.nodeReference?.id;
        if (!nodeId) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'spriteFrameAssign requires nodeReference.id.' });
        const componentPath = await this.componentPath(nodeId, 'cc.Sprite');
        const before = await this.queryNodeDump(nodeId);
        const spriteBefore = before?.__comps__?.find((component) => component.type === 'cc.Sprite')?.value;
        const previous = spriteBefore && 'spriteFrame' in spriteBefore ? this.unwrapValue(spriteBefore.spriteFrame) : null;
        const requestedId = args.spriteFrameReference?.id ?? null;
        const previousId = previous && typeof previous === 'object' && 'uuid' in previous && typeof previous.uuid === 'string' ? previous.uuid : null;
        if (previousId === requestedId) return { nodeReference: { id: nodeId, type: args.nodeReference.type ?? 'cc.Node' }, spriteFrameReference: requestedId ? { id: requestedId, type: args.spriteFrameReference?.type ?? 'cc.SpriteFrame' } : null, changed: false };
        const accepted = await Editor.Message.request('scene', 'set-property', { uuid: nodeId, path: `${componentPath}.spriteFrame`, dump: { value: requestedId ? { uuid: requestedId } : null, type: 'cc.SpriteFrame' } });
        if (accepted === false) throw new ToolError({ code: 'MUTATION_REFUSED', status: 422, message: 'Creator refused SpriteFrame assignment.' });
        const after = await this.queryNodeDump(nodeId);
        const spriteAfter = after?.__comps__?.find((component) => component.type === 'cc.Sprite')?.value;
        const readBack = spriteAfter && 'spriteFrame' in spriteAfter ? this.unwrapValue(spriteAfter.spriteFrame) : null;
        const readBackId = readBack && typeof readBack === 'object' && 'uuid' in readBack && typeof readBack.uuid === 'string' ? readBack.uuid : null;
        if (readBackId !== requestedId) throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: 'SpriteFrame assignment did not match Creator read-back.' });
        await Editor.Message.request('scene', 'snapshot');
        return { nodeReference: { id: nodeId, type: args.nodeReference.type ?? 'cc.Node' }, spriteFrameReference: requestedId ? { id: requestedId, type: args.spriteFrameReference?.type ?? 'cc.SpriteFrame' } : null, changed: true };
    }

    @utcpTool('spriteFrameBatchAssign', 'Assign or clear SpriteFrames on a bounded set of live Sprite nodes with per-item read-back outcomes.', { type: 'object', additionalProperties: false, properties: { items: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, spriteFrameReference: InstanceReferenceSchema }, required: ['nodeReference'] } } }, required: ['items'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'partial'] }, 'POST', ['ui', 'sprite', 'frame', 'batch', 'assign'])
    async spriteFrameBatchAssign(args: { items: Array<{ nodeReference: IInstanceReference, spriteFrameReference?: IInstanceReference }> }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.items) || args.items.length < 1 || args.items.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'items must contain 1 to 32 assignments.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, item] of args.items.entries()) {
            try {
                outcomes.push({ index, ok: true, result: await this.spriteFrameAssign(item) });
            } catch (error) {
                outcomes.push({ index, ok: false, nodeReference: item?.nodeReference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length };
    }

    @utcpTool('spriteInspect', 'Inspect bounded live Sprite components under one scene node with SpriteFrame and visual property read-back.', { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema }, required: ['nodeReference'] }, { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, spriteReference: InstanceReferenceSchema, spriteFrameReference: { type: ['object', 'null'] }, color: {}, sizeMode: {}, trim: {}, type: { type: 'string' } }, required: ['nodeReference', 'spriteReference', 'spriteFrameReference', 'color', 'sizeMode', 'trim', 'type'] }, 'GET', ['ui', 'sprite', 'image', 'inspect'])
    async spriteInspect(args: { nodeReference: IInstanceReference }): Promise<Record<string, unknown>> {
        const nodeId = args.nodeReference?.id;
        if (!nodeId) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'spriteInspect requires nodeReference.id.' });
        const node = await this.queryNodeDump(nodeId);
        const sprite = node?.__comps__?.find((component) => component.type === 'cc.Sprite');
        if (!sprite) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Node ${nodeId} does not contain cc.Sprite.` });
        const value = sprite.value ?? {};
        const frame = 'spriteFrame' in value ? this.unwrapValue(value.spriteFrame) : null;
        const frameId = frame && typeof frame === 'object' && 'uuid' in frame && typeof frame.uuid === 'string' ? frame.uuid : null;
        const field = (name: string): unknown => name in value ? this.unwrapValue(value[name]) : null;
        const spriteUuidValue = sprite.value?.uuid;
        const spriteId = typeof spriteUuidValue === 'string' ? spriteUuidValue : spriteUuidValue && typeof spriteUuidValue === 'object' && typeof spriteUuidValue.value === 'string' ? spriteUuidValue.value : null;
        if (typeof spriteId !== 'string' || !spriteId) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `Creator returned cc.Sprite without an authoritative UUID.` });
        return { nodeReference: { id: nodeId, type: args.nodeReference.type ?? 'cc.Node' }, spriteReference: { id: spriteId, type: 'cc.Sprite' }, spriteFrameReference: frameId ? { id: frameId, type: 'cc.SpriteFrame' } : null, color: field('color'), sizeMode: field('sizeMode'), trim: field('trim'), type: 'cc.Sprite' };
    }
    @utcpTool('spriteConfigure', 'Configure bounded live Sprite visual properties with authoritative component read-back.', { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, sizeMode: { type: 'integer', minimum: 0, maximum: 3 }, trim: { type: 'boolean' }, color: { type: 'object', additionalProperties: false, properties: { r: { type: 'integer', minimum: 0, maximum: 255 }, g: { type: 'integer', minimum: 0, maximum: 255 }, b: { type: 'integer', minimum: 0, maximum: 255 }, a: { type: 'integer', minimum: 0, maximum: 255 } }, required: ['r', 'g', 'b', 'a'] } }, required: ['nodeReference'] }, { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, spriteReference: InstanceReferenceSchema, changed: { type: 'array' }, properties: { type: 'object' }, verified: { type: 'boolean' } }, required: ['nodeReference', 'spriteReference', 'changed', 'properties', 'verified'] }, 'POST', ['ui', 'sprite', 'configure', 'color', 'size', 'trim'])
    async spriteConfigure(args: { nodeReference: IInstanceReference, sizeMode?: number, trim?: boolean, color?: { r: number, g: number, b: number, a: number } }): Promise<Record<string, unknown>> {
        const nodeId = args.nodeReference?.id;
        if (!nodeId) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'spriteConfigure requires nodeReference.id.' });
        if (args.sizeMode !== undefined && (!Number.isInteger(args.sizeMode) || args.sizeMode < 0 || args.sizeMode > 3)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sizeMode must be an integer from 0 to 3.' });
        if (args.trim !== undefined && typeof args.trim !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'trim must be boolean.' });
        if (args.color !== undefined && !['r', 'g', 'b', 'a'].every((key) => Number.isInteger(args.color?.[key as keyof typeof args.color]) && (args.color?.[key as keyof typeof args.color] as number) >= 0 && (args.color?.[key as keyof typeof args.color] as number) <= 255)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'color channels must be integers from 0 to 255.' });
        const fields: Array<{ name: string, value: number | boolean | { r: number, g: number, b: number, a: number }, type: string }> = [];
        if (args.sizeMode !== undefined) fields.push({ name: 'sizeMode', value: args.sizeMode, type: 'cc.Enum' });
        if (args.trim !== undefined) fields.push({ name: 'trim', value: args.trim, type: 'cc.Boolean' });
        if (args.color !== undefined) fields.push({ name: 'color', value: args.color, type: 'cc.Color' });
        if (fields.length === 0) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'At least one Sprite property is required.' });
        const componentPath = await this.componentPath(nodeId, 'cc.Sprite');
        const before = await this.queryNodeDump(nodeId);
        const spriteBefore = before?.__comps__?.find((component) => component.type === 'cc.Sprite')?.value;
        if (!spriteBefore) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Node ${nodeId} does not contain cc.Sprite.` });
        const previous = new Map<string, IProperty['value']>(fields.map((field) => [field.name, this.unwrapValue(spriteBefore[field.name]) as IProperty['value']]));
        try {
            for (const field of fields) {
                const accepted = await Editor.Message.request('scene', 'set-property', { uuid: nodeId, path: `${componentPath}.${field.name}`, dump: { value: field.value, type: field.type } });
                if (accepted === false) throw new Error(`Creator refused Sprite property ${field.name}.`);
            }
            const inspected = await this.spriteInspect({ nodeReference: args.nodeReference });
            for (const field of fields) if (JSON.stringify(inspected[field.name]) !== JSON.stringify(field.value)) throw new Error(`Sprite property ${field.name} read-back mismatch.`);
            await Editor.Message.request('scene', 'snapshot');
            return { nodeReference: inspected.nodeReference, spriteReference: inspected.spriteReference, changed: fields.map((field) => field.name), properties: Object.fromEntries(fields.map((field) => [field.name, field.value])), verified: true };
        } catch (error) {
            for (const field of fields) await Editor.Message.request('scene', 'set-property', { uuid: nodeId, path: `${componentPath}.${field.name}`, dump: { value: previous.get(field.name), type: field.type } }).catch(() => undefined);
            throw new ToolError({ code: 'SPRITE_CONFIGURE_FAILED', status: 502, message: 'Creator could not persist Sprite properties.', details: { cause: error instanceof Error ? error.message : String(error) }, recovery: 'Inspect the Sprite node and retry with supported sizeMode, trim, or color values.' });
        }
    }

    @utcpTool('spriteBatchConfigure', 'Configure bounded Sprite nodes with per-item authoritative read-back outcomes.', { type: 'object', additionalProperties: false, properties: { items: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, sizeMode: { type: 'integer', minimum: 0, maximum: 3 }, trim: { type: 'boolean' }, color: { type: 'object' } }, required: ['nodeReference'] } } }, required: ['items'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'partial'] }, 'POST', ['ui', 'sprite', 'batch', 'configure'])
    async spriteBatchConfigure(args: { items: Array<{ nodeReference: IInstanceReference, sizeMode?: number, trim?: boolean, color?: { r: number, g: number, b: number, a: number } }> }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.items) || args.items.length < 1 || args.items.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'items must contain 1 to 32 Sprite configurations.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, item] of args.items.entries()) {
            try { outcomes.push({ index, ok: true, result: await this.spriteConfigure(item) }); }
            catch (error) { outcomes.push({ index, ok: false, nodeReference: item?.nodeReference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } }); }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length };
    }
    @utcpTool('spriteBatchInspect', 'Inspect a bounded batch of live Sprite nodes with SpriteFrame and visual read-back.', { type: 'object', additionalProperties: false, properties: { nodeReferences: { type: 'array', minItems: 1, maxItems: 64, items: InstanceReferenceSchema } }, required: ['nodeReferences'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['ui', 'sprite', 'image', 'batch', 'inspect'])
    async spriteBatchInspect(args: { nodeReferences: IInstanceReference[] }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.nodeReferences) || args.nodeReferences.length < 1 || args.nodeReferences.length > 64) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeReferences must contain 1 to 64 items.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, nodeReference] of args.nodeReferences.entries()) {
            try {
                items.push({ index, ok: true, result: await this.spriteInspect({ nodeReference }) });
            } catch (error) {
                items.push({ index, ok: false, nodeReference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        return { items, succeeded, failed: items.length - succeeded, truncated: false };
    }


    @utcpTool(
        'uiLayoutReport',
        'Return a bounded, read-only live 2D UI layout report with optional ephemeral overlay.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                root: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, type: { type: 'string' } } },
                rootPath: { type: 'string' },
                designResolution: { type: 'object', additionalProperties: false, properties: { width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } }, required: ['width', 'height'] },
                viewport: { type: 'object', additionalProperties: false, properties: { width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } }, required: ['width', 'height'] },
                fitMode: { type: 'string', enum: ['fitWidth', 'fitHeight', 'contain', 'cover', 'stretch', 'none'], default: 'contain' },
                maxNodes: { type: 'integer', minimum: 1, maximum: 5000, default: 128 },
                maxIssues: { type: 'integer', minimum: 1, maximum: 5000, default: 256 },
                maxBytes: { type: 'integer', minimum: 256, maximum: 2097152, default: 524288 },
                overlay: { type: 'boolean', default: false },
                alignmentTolerance: { type: 'number', minimum: 0, maximum: 1000, default: 1 },
                gapTolerance: { type: 'number', minimum: 0, maximum: 1000, default: 2 },
            },
            required: ['designResolution', 'viewport'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                complete: { type: 'boolean' },
                designResolution: { type: 'object' },
                viewport: { type: 'object' },
                fitMode: { type: 'string' },
                fit: { type: 'object' },
                root: { type: 'object' },
                nodes: { type: 'array' },
                issues: { type: 'array' },
                truncation: { type: 'array' },
                overlay: { type: 'object' },
                tolerances: { type: 'object' },
                error: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['code', 'message', 'evidence'],
                    properties: { code: { type: 'string' }, message: { type: 'string' }, evidence: { type: 'object' } },
                },
            },
            oneOf: [
                { required: ['error'] },
                { required: ['complete', 'designResolution', 'viewport', 'fitMode', 'fit', 'root', 'nodes', 'issues', 'truncation', 'overlay', 'tolerances'] },
            ],
        },
        'POST',
        ['ui', 'layout', 'report', 'geometry', 'diagnostics']
    )
    async uiLayoutReport(args: LayoutReportRequest): Promise<LayoutReportResult> {
        let dirtyBefore: boolean | undefined;
        try {
            const value = await Editor.Message.request('scene', 'query-dirty');
            if (typeof value === 'boolean') dirtyBefore = value;
        } catch (error) { console.warn('[cx3][ui] uiLayoutReport: failed to read dirty-before state', error); }

        const raw = await Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'uiLayoutReport', args: [args] }) as unknown;
        let dirtyAfter: boolean | undefined;
        try {
            const value = await Editor.Message.request('scene', 'query-dirty');
            if (typeof value === 'boolean') dirtyAfter = value;
        } catch (error) { console.warn('[cx3][ui] uiLayoutReport: failed to read dirty-after state', error); }

        if (raw && typeof raw === 'object' && 'overlay' in raw) {
            const result = raw as LayoutReport;
            if (dirtyBefore !== undefined) result.overlay.dirtyBefore = dirtyBefore;
            if (dirtyAfter !== undefined) result.overlay.dirtyAfter = dirtyAfter;
            if (dirtyBefore !== undefined && dirtyAfter !== undefined) result.overlay.dirtyPreserved = dirtyBefore === dirtyAfter;
            if (result.overlay.requested && result.overlay.dirtyPreserved !== true) {
                delete result.overlay.artifact;
                result.overlay.valid = false;
                result.overlay.rendered = false;
                result.overlay.error = {
                    code: dirtyBefore === undefined || dirtyAfter === undefined ? 'OVERLAY_DIRTY_STATE_UNAVAILABLE' : 'OVERLAY_DIRTY_STATE_CHANGED',
                    message: dirtyBefore === undefined || dirtyAfter === undefined
                        ? 'Scene dirty state could not be verified before and after overlay rendering'
                        : 'Scene dirty state changed while rendering the overlay',
                    evidence: { dirtyBefore, dirtyAfter },
                };
            }
            return finalizeUiLayoutReport(result, Math.min(args.maxBytes ?? 512 * 1024, 2 * 1024 * 1024));
        }
        return raw as LayoutReportResult;
    }
    @utcpTool(
        'uiAccessibilityAudit',
        'Audit active UI nodes for inferred labels, known interactable components, and missing or duplicate labels. Read-only inference only; it does not provide or verify screen-reader runtime support.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                root: InstanceReferenceSchema,
                rootPath: { type: 'string', minLength: 1, maxLength: 256 },
                maxNodes: { type: 'integer', minimum: 1, maximum: 5000, default: 128 },
                maxIssues: { type: 'integer', minimum: 1, maximum: 5000, default: 256 },
            },
            oneOf: [
                { required: ['root'], not: { required: ['rootPath'] } },
                { required: ['rootPath'], not: { required: ['root'] } },
            ],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                complete: { type: 'boolean' },
                valid: { type: 'boolean' },
                truncated: { type: 'boolean' },
                checkedNodes: { type: 'integer', minimum: 0 },
                root: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { uuid: { type: 'string' }, path: { type: 'string' }, name: { type: 'string' } },
                    required: ['uuid', 'path', 'name'],
                },
                nodes: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            uuid: { type: 'string' },
                            path: { type: 'string' },
                            name: { type: 'string' },
                            active: { type: 'boolean', const: true },
                            role: { type: 'string', enum: ['button', 'toggle', 'slider', 'edit-box', 'label', 'generic'] },
                            label: { type: ['string', 'null'] },
                            labelSource: { type: ['string', 'null'], enum: ['label', 'descendant-label', 'edit-box-placeholder', 'node-name', null] },
                            interactable: { type: 'boolean' },
                            interactionComponent: { type: ['string', 'null'], enum: ['cc.Button', 'cc.Toggle', 'cc.Slider', 'cc.EditBox', null] },
                            components: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['uuid', 'path', 'name', 'active', 'role', 'label', 'labelSource', 'interactable', 'interactionComponent', 'components'],
                    },
                },
                issues: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            code: { type: 'string', enum: ['MISSING_ACCESSIBLE_LABEL', 'DUPLICATE_ACCESSIBLE_LABEL'] },
                            severity: { type: 'string', const: 'warning' },
                            nodeId: { type: 'string' },
                            relatedNodeIds: { type: 'array', items: { type: 'string' } },
                            message: { type: 'string' },
                            evidence: { type: 'object' },
                        },
                        required: ['code', 'severity', 'nodeId', 'relatedNodeIds', 'message', 'evidence'],
                    },
                },
                truncation: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', enum: ['nodes', 'issues'] },
                            limit: { type: 'integer' },
                            omitted: { type: 'integer', minimum: 0 },
                            reason: { type: 'string' },
                        },
                        required: ['kind', 'limit', 'reason'],
                    },
                },
                error: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { code: { type: 'string' }, message: { type: 'string' }, evidence: { type: 'object' } },
                    required: ['code', 'message', 'evidence'],
                },
            },
            oneOf: [
                { required: ['error'] },
                { required: ['complete', 'valid', 'truncated', 'checkedNodes', 'root', 'nodes', 'issues', 'truncation'] },
            ],
        },
        'GET',
        ['ui', 'accessibility', 'audit', 'label', 'interactable', 'read-only']
    )
    async uiAccessibilityAudit(args: UiAccessibilityAuditRequest): Promise<UiAccessibilityAuditResult> {
        return await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'ccp3x',
            method: 'uiAccessibilityAudit',
            args: [args],
        }) as UiAccessibilityAuditResult;
    }

    @utcpTool(
        'uiSafeAreaInspect',
        'Inspect bounded 2D UI geometry against a caller-provided safe-area rectangle or root-relative insets without mutating the scene.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                root: InstanceReferenceSchema,
                rootPath: { type: 'string', minLength: 1, maxLength: 256 },
                safeArea: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        rect: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                x: { type: 'number' }, y: { type: 'number' },
                                width: { type: 'number', exclusiveMinimum: 0 },
                                height: { type: 'number', exclusiveMinimum: 0 },
                            },
                            required: ['x', 'y', 'width', 'height'],
                        },
                        insets: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                top: { type: 'number', minimum: 0 }, right: { type: 'number', minimum: 0 },
                                bottom: { type: 'number', minimum: 0 }, left: { type: 'number', minimum: 0 },
                            },
                            required: ['top', 'right', 'bottom', 'left'],
                        },
                        x: { type: 'number' }, y: { type: 'number' },
                        width: { type: 'number', exclusiveMinimum: 0 },
                        height: { type: 'number', exclusiveMinimum: 0 },
                    },
                    oneOf: [
                        { required: ['rect'] },
                        { required: ['insets'] },
                        { required: ['x', 'y', 'width', 'height'] },
                    ],
                },
                maxNodes: { type: 'integer', minimum: 1, maximum: 5000, default: 128 },
                maxIssues: { type: 'integer', minimum: 1, maximum: 5000, default: 256 },
            },
            required: ['safeArea'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                complete: { type: 'boolean' }, valid: { type: 'boolean' }, truncated: { type: 'boolean' },
                safeArea: { type: 'object' }, root: { type: 'object' },
                checkedNodes: { type: 'integer' }, nodes: { type: 'array' }, issues: { type: 'array' },
                truncation: { type: 'array' },
                error: { type: 'object', additionalProperties: false, required: ['code', 'message', 'evidence'], properties: { code: { type: 'string' }, message: { type: 'string' }, evidence: { type: 'object' } } },
            },
            oneOf: [
                { required: ['error'] },
                { required: ['complete', 'valid', 'safeArea', 'root', 'checkedNodes', 'nodes', 'issues', 'truncation', 'truncated'] },
            ],
        },
        'POST',
        ['ui', 'safe-area', 'inspect', 'geometry', 'diagnostics']
    )
    async uiSafeAreaInspect(args: UiSafeAreaInspectRequest): Promise<UiSafeAreaInspectResult> {
        return await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'ccp3x', method: 'uiSafeAreaInspect', args: [args],
        }) as UiSafeAreaInspectResult;
    }


    @utcpTool(
        'uiLayoutInspect',
        'Inspect bounded UI layout constraints and normalized world rectangles for a scene subtree.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { id: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' }, type: { type: 'string', const: 'cc.Node' } },
                    required: ['id'],
                },
                maxNodes: { type: 'integer', minimum: 1, maximum: 128, default: 64 },
            },
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                nodes: {
                    type: 'array',
                    maxItems: 128,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            reference: {
                                type: 'object',
                                additionalProperties: false,
                                properties: { id: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' }, type: { type: 'string', const: 'cc.Node' } },
                                required: ['id', 'type'],
                            },
                            name: { type: 'string' },
                            active: { type: 'boolean' },
                            position: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
                            size: { type: ['object', 'null'], additionalProperties: false, properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] },
                            anchor: { type: ['object', 'null'], additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
                            worldRect: { type: ['object', 'null'], additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 } }, required: ['x', 'y', 'width', 'height'] },
                            components: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['reference', 'name', 'active', 'position', 'size', 'anchor', 'worldRect', 'components'],
                    },
                },
                truncated: { type: 'boolean' },
            },
            required: ['nodes', 'truncated'],
        },
        'POST',
        ['ui', 'layout', 'inspect', 'geometry']
    )
    async uiLayoutInspect(args: { reference?: IInstanceReference, maxNodes?: number }): Promise<{ nodes: UiLayoutNode[], truncated: boolean }> {
        const { rootUuid, maxNodes } = this.validateUiLayoutInspectArgs(args);
        return this.inspectLayout(rootUuid, maxNodes, true);
    }

    @utcpTool(
        'uiLayoutApply',
        'Apply explicit UI geometry changes, or operation reflow for a complete bounded subtree using native 3.7.3 Layout/Widget ordering. Reflow preflights limits and returns before/after geometry, preservation and restoration evidence; never saves the scene or claims atomicity or verified undo/redo.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                operation: { type: 'string', enum: ['apply', 'reflow'], default: 'apply' },
                maxNodes: { type: 'integer', minimum: 1, maximum: 128, default: 32, description: 'Reflow only; the entire subtree must fit before mutation.' },
                maxDepth: { type: 'integer', minimum: 0, maximum: 8, default: 4, description: 'Reflow only; root depth is zero, with no truncation allowed.' },
                maxBytes: { type: 'integer', minimum: 32768, maximum: 131072, default: 32768, description: 'Reflow only; UTF-8 bytes over the complete serialized response.' },
                position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, additionalProperties: false },
                size: { type: 'object', properties: { width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 } }, required: ['width', 'height'], additionalProperties: false },
                anchor: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'], additionalProperties: false },
                active: { type: 'boolean' },
            },
            required: ['reference'],
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean' }, layout: { type: ['object', 'null'] },
                operation: { const: 'reflow' }, sceneSaved: { const: false }, complete: { type: 'boolean' },
                reference: InstanceReferenceSchema, checkedNodes: { type: 'integer' }, changedNodeIds: { type: 'array', items: { type: 'string' } },
                restoration: { type: 'string', enum: ['not-needed', 'confirmed', 'partial', 'unknown'] },
                history: { type: 'object', properties: { status: { type: 'string', enum: ['not-requested', 'snapshot-requested', 'unknown'] }, undoRedoVerified: { const: false } }, required: ['status', 'undoRedoVerified'] },
                preservation: { type: 'string', enum: ['confirmed', 'unknown'] },
                before: { type: 'array', items: { type: 'object' } }, after: { type: 'array', items: { type: 'object' } },
                order: { type: 'array', items: { type: 'object' } }, limits: { type: 'object' }, engineVersion: { type: 'string' },
                error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, mutationStarted: { type: 'boolean' } }, required: ['code', 'message', 'mutationStarted'] },
            },
            oneOf: [
                { required: ['success', 'layout'] },
                { required: ['success', 'operation', 'sceneSaved', 'complete', 'reference', 'checkedNodes', 'changedNodeIds', 'restoration', 'history', 'preservation'] },
            ],
        },
        'POST',
        ['ui', 'layout', 'apply', 'mutation']
    )
    async uiLayoutApply(args: { reference: IInstanceReference, operation?: 'apply' | 'reflow', maxNodes?: number, maxDepth?: number, maxBytes?: number, position?: { x?: number, y?: number, z?: number }, size?: { width: number, height: number }, anchor?: { x: number, y: number }, active?: boolean }): Promise<{ success: true, layout: UiLayoutNode | null } | UiReflowResult> {
        if (args?.operation === 'reflow') {
            if (Object.keys(args).some(key => !['operation', 'reference', 'maxNodes', 'maxDepth', 'maxBytes'].includes(key))
                || !this.isRecord(args.reference) || Object.keys(args.reference).some(key => key !== 'id' && key !== 'type')
                || typeof args.reference.id !== 'string' || args.reference.id.length < 1 || args.reference.id.length > 256 || args.reference.id.trim() !== args.reference.id
                || (args.reference.type !== undefined && args.reference.type !== 'cc.Node')) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Reflow accepts only a typed cc.Node reference and maxNodes/maxDepth/maxBytes; explicit property changes cannot be mixed with reflow.' });
            }
            const maxNodes = args.maxNodes ?? 32; const maxDepth = args.maxDepth ?? 4; const maxBytes = args.maxBytes ?? 32768;
            if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 128 || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 8 || !Number.isInteger(maxBytes) || maxBytes < 32768 || maxBytes > 131072) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Reflow requires maxNodes 1..128, maxDepth 0..8 and maxBytes 32768..131072.' });
            }
            const authoritative = await this.queryNodeDump(args.reference.id);
            if (!authoritative) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'Reflow node is not in the active scene.' });
            this.normalizeLayoutDump(args.reference.id, authoritative, true);
            let result: unknown;
            try {
                result = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: 'ccp3x', method: 'uiLayoutReflow', args: [{ nodeUuid: args.reference.id, maxNodes, maxDepth, maxBytes }],
                });
            } catch (error: unknown) {
                throw new ToolError({ code: 'UI_REFLOW_OUTCOME_UNKNOWN', status: 502, message: 'Reflow scene IPC failed after dispatch; mutation and restoration are unknown. Do not blindly retry.', details: { reference: args.reference, sceneSaved: false, restoration: 'unknown', cause: (error instanceof Error ? error.message : String(error)).slice(0, 512) }, recovery: 'Inspect the selected subtree and scene history before any retry.' });
            }
            if (!isUiReflowResult(result, args.reference.id, maxNodes, maxBytes)) {
                throw new ToolError({ code: 'UI_REFLOW_OUTCOME_UNKNOWN', status: 502, message: 'Reflow returned invalid or oversized evidence after dispatch; mutation and restoration are unknown.', details: { reference: args.reference, sceneSaved: false, restoration: 'unknown' }, recovery: 'Inspect the selected subtree and scene history; do not infer a safe refusal or blindly retry.' });
            }
            return result;
        }
        if (args?.operation !== undefined && args.operation !== 'apply') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'uiLayoutApply operation must be apply or reflow.' });
        if (args.maxNodes !== undefined || args.maxDepth !== undefined || args.maxBytes !== undefined) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Subtree limits apply only to operation reflow.' });
        const node = await this.queryNodeDump(args.reference.id);
        if (!node) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: `UI node ${args.reference.id} not found` });
        const componentPath = await this.componentPath(args.reference.id, 'cc.UITransform');
        const changes: Array<{ path: string, dump: any, original: any }> = [];
        if (args.position) changes.push({ path: 'position', dump: { value: { x: args.position.x ?? 0, y: args.position.y ?? 0, z: args.position.z ?? 0 }, type: 'cc.Vec3' }, original: node.position });
        if (args.size) changes.push({ path: `${componentPath}._contentSize`, dump: { value: args.size, type: 'cc.Size' }, original: { value: node.__comps__?.find((component: any) => component.type === 'cc.UITransform')?.value?.contentSize, type: 'cc.Size' } });
        if (args.anchor) changes.push({ path: `${componentPath}._anchorPoint`, dump: { value: args.anchor, type: 'cc.Vec2' }, original: { value: node.__comps__?.find((component: any) => component.type === 'cc.UITransform')?.value?.anchorPoint, type: 'cc.Vec2' } });
        if (args.active !== undefined) changes.push({ path: 'active', dump: { value: args.active, type: 'Boolean' }, original: node.active });
        if (changes.length === 0) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'uiLayoutApply requires at least one layout change' });
        if (changes.some((change) => !change.original || typeof change.original !== 'object' || !Object.prototype.hasOwnProperty.call(change.original, 'value'))) {
            throw new ToolError({ code: 'PRECONDITION_FAILED', status: 422, message: 'uiLayoutApply cannot capture a complete rollback snapshot for the requested fields' });
        }
        const applied: typeof changes = [];
        try {
            for (const change of changes) {
                const result = await Editor.Message.request('scene', 'set-property', { uuid: args.reference.id, path: change.path, dump: change.dump });
                if (result === false) throw new Error(`Creator refused ${change.path}`);
                applied.push(change);
            }
            const layout = (await this.inspectLayout(args.reference.id, 1)).nodes[0] ?? null;
            if (!layout) throw new Error('layout read-back unavailable');
            await Editor.Message.request('scene', 'snapshot');
            return { success: true, layout };
        } catch (error) {
            try {
                for (const change of [...applied].reverse()) {
                    const rollback = await Editor.Message.request('scene', 'set-property', { uuid: args.reference.id, path: change.path, dump: change.original });
                    if (rollback === false) throw new Error(`Creator refused rollback of ${change.path}`);
                }
                await Editor.Message.request('scene', 'snapshot-abort');
            } catch (rollbackError) {
                throw new ToolError({
                    code: 'ROLLBACK_FAILED',
                    status: 500,
                    message: `uiLayoutApply failed and node ${args.reference.id} could not be restored`,
                    details: { cause: error instanceof Error ? error.message : String(error), rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) },
                    recovery: `Inspect node ${args.reference.id} and restore its layout before retrying.`,
                });
            }
            throw new ToolError({ code: 'MUTATION_FAILED', status: 500, message: `uiLayoutApply failed for node ${args.reference.id}`, details: { cause: error instanceof Error ? error.message : String(error) }, recovery: 'The applied fields were rolled back; inspect the node before retrying.' });
        }
    }


    @utcpTool(
        'uiFocusNavigation',
        'Compute deterministic bounded focus order and adjacent navigation links from readable UI node layout. Read-only; does not claim runtime focus support.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                references: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: InstanceReferenceSchema },
                axis: { type: 'string', enum: ['horizontal', 'vertical'] },
                direction: { type: 'string', enum: ['ascending', 'descending'], default: 'ascending' },
            },
            required: ['references', 'axis'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                references: { type: 'array', items: InstanceReferenceSchema },
                links: { type: 'array', items: { type: 'object' } },
            },
            required: ['references', 'links'],
        },
        'GET',
        ['ui', 'focus', 'navigation', 'layout', 'inspect']
    )
    async uiFocusNavigation(args: { references: IInstanceReference[], axis: 'horizontal' | 'vertical', direction?: 'ascending' | 'descending' }): Promise<{ references: IInstanceReference[], links: Array<{ from: IInstanceReference, to: IInstanceReference | null }> }> {
        if (!Array.isArray(args.references) || args.references.length < 1 || args.references.length > 100) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'uiFocusNavigation references must contain 1 to 100 nodes.' });
        }
        const ids = args.references.map((reference) => reference?.id);
        if (ids.some((id) => typeof id !== 'string' || id.trim().length === 0) || new Set(ids).size !== ids.length) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'uiFocusNavigation references must contain unique non-empty node UUIDs.' });
        }
        const validIds = ids as string[];
        const dumps = await Promise.all(validIds.map(async (id) => ({ id, dump: await this.queryNodeDump(id) })));
        const ordered = dumps.map(({ id, dump }) => {
            if (!dump) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: `UI node ${id} not found` });
            const position = this.unwrapValue(dump.position);
            const point = this.isRecord(position) ? position : {};
            const coordinate = this.finiteNumber(args.axis === 'horizontal' ? point.x : point.y, NaN);
            if (!Number.isFinite(coordinate)) {
                throw new ToolError({ code: 'INVALID_TARGET', status: 422, message: `UI node ${id} has no readable position for ${args.axis} navigation.` });
            }
            return { id, coordinate };
        }).sort((a, b) => {
            const delta = a.coordinate - b.coordinate;
            return (args.direction ?? 'ascending') === 'descending' ? -delta || validIds.indexOf(a.id) - validIds.indexOf(b.id) : delta || validIds.indexOf(a.id) - validIds.indexOf(b.id);
        });
        const references = ordered.map(({ id }) => ({ id, type: 'cc.Node' }));
        const links = references.map((from, index) => ({ from, to: references[index + 1] ?? null }));
        return { references, links };
    }

    @utcpTool(
        'uiLayoutAlign',
        'Align or evenly distribute 2D UI nodes that share one parent. Uses local UITransform bounds, preserves Z, preflights every node, snapshots once, and rolls back partial writes.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                references: { type: 'array', minItems: 2, maxItems: 100, uniqueItems: true, items: InstanceReferenceSchema },
                operation: { type: 'string', enum: ['align', 'distribute'] },
                axis: { type: 'string', enum: ['horizontal', 'vertical'] },
                edge: { type: 'string', enum: ['left', 'right', 'center', 'top', 'bottom', 'middle'], description: 'Required only for align. Horizontal accepts left/right/center; vertical accepts top/bottom/middle.' },
            },
            required: ['references', 'operation', 'axis'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                success: { type: 'boolean', const: true },
                references: { type: 'array', items: InstanceReferenceSchema },
                layouts: { type: 'array', items: { type: 'object' } },
            },
            required: ['success', 'references', 'layouts'],
        },
        'POST',
        ['ui', 'layout', 'align', 'distribute', 'batch', 'mutation']
    )
    async uiLayoutAlign(args: { references: IInstanceReference[], operation: LayoutAlignOperation, axis: LayoutAlignAxis, edge?: LayoutAlignEdge }): Promise<{ success: true, references: IInstanceReference[], layouts: UiLayoutNode[] }> {
        const minimum = args.operation === 'align' ? 2 : 3;
        if (args.references.length < minimum) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${args.operation} requires at least ${minimum} nodes` });
        }
        const uniqueIds = [...new Set(args.references.map((reference) => reference.id))];
        if (uniqueIds.length !== args.references.length) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain unique node UUIDs' });
        }

        const dumps = await Promise.all(uniqueIds.map(async (id) => ({ id, dump: await this.queryNodeDump(id) })));
        const parentIds = new Set<string>();
        const items = dumps.map(({ id, dump }) => {
            if (!dump) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: `UI node ${id} not found` });
            const parentId = dump.parent?.value?.uuid ?? dump.parent?.uuid;
            if (!parentId) throw new ToolError({ code: 'INVALID_TARGET', status: 422, message: `UI node ${id} has no queryable parent` });
            parentIds.add(parentId);
            const positionValue = this.unwrapValue(dump.position);
            const position = this.isRecord(positionValue) ? positionValue : { x: 0, y: 0, z: 0 };
            const transform = dump.__comps__?.find((component) => component.type === 'cc.UITransform');
            const value = transform ? this.unwrapValue(transform.value) : null;
            const transformRecord = this.isRecord(value) ? value : null;
            const sizeValue = transformRecord ? this.unwrapValue(transformRecord.contentSize) ?? this.unwrapValue(transformRecord._contentSize) : null;
            const anchorValue = transformRecord ? this.unwrapValue(transformRecord.anchorPoint) ?? this.unwrapValue(transformRecord._anchorPoint) : null;
            const size = this.isRecord(sizeValue) ? sizeValue : null;
            const anchor = this.isRecord(anchorValue) ? anchorValue : null;
            if (typeof size?.width !== 'number' || typeof size?.height !== 'number' || typeof anchor?.x !== 'number' || typeof anchor?.y !== 'number') {
                throw new ToolError({ code: 'INVALID_TARGET', status: 422, message: `UI node ${id} requires a readable cc.UITransform size and anchor` });
            }
            return {
                id,
                position: { x: this.finiteNumber(position.x, 0), y: this.finiteNumber(position.y, 0), z: this.finiteNumber(position.z, 0) },
                worldRect: {
                    x: this.finiteNumber(position.x, 0) - size.width * anchor.x,
                    y: this.finiteNumber(position.y, 0) - size.height * anchor.y,
                    width: size.width,
                    height: size.height,
                },
            };
        });
        if (parentIds.size !== 1) {
            throw new ToolError({ code: 'INVALID_TARGET', status: 422, message: 'uiLayoutAlign requires all nodes to share one parent so local-space writes remain deterministic' });
        }

        let updates: LayoutAlignmentUpdate[];
        try {
            updates = calculateLayoutAlignment(items, args.operation, args.axis, args.edge);
        } catch (error: unknown) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: error instanceof Error ? error.message : String(error) });
        }
        const originals = new Map(items.map((item) => [item.id, item.position]));
        const applied: string[] = [];
        let layouts: UiLayoutNode[] = [];
        try {
            for (const update of updates) {
                const accepted = await Editor.Message.request('scene', 'set-property', { uuid: update.id, path: 'position', dump: { value: update.position, type: 'cc.Vec3' } });
                if (accepted === false) throw new Error(`Creator refused position update for ${update.id}`);
                applied.push(update.id);
            }
            layouts = (await Promise.all(uniqueIds.map(async (id) => (await this.inspectLayout(id, 1)).nodes[0] ?? null)))
                .filter((layout): layout is UiLayoutNode => layout !== null);
            if (layouts.length !== uniqueIds.length) throw new Error('Creator did not return every updated node during read-back');
            await Editor.Message.request('scene', 'snapshot');
        } catch (error: unknown) {
            for (const id of applied.reverse()) {
                const original = originals.get(id);
                if (original) await Editor.Message.request('scene', 'set-property', { uuid: id, path: 'position', dump: { value: original, type: 'cc.Vec3' } });
            }
            await Editor.Message.request('scene', 'snapshot-abort').catch(() => undefined);
            throw new ToolError({ code: 'MUTATION_FAILED', status: 500, message: error instanceof Error ? error.message : String(error) });
        }
        return { success: true, references: uniqueIds.map((id) => ({ id, type: 'cc.Node' })), layouts };
    }
    @utcpTool(
        'uiLayoutValidate',
        'Validate bounded, read-only UI geometry for clipping, overlap, anchors, and safe-area constraints.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                root: InstanceReferenceSchema,
                rootPath: { type: 'string', minLength: 1, maxLength: 256 },
                designResolution: { type: 'object', additionalProperties: false, properties: { width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } }, required: ['width', 'height'] },
                viewport: { type: 'object', additionalProperties: false, properties: { width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } }, required: ['width', 'height'] },
                fitMode: { type: 'string', enum: ['fitWidth', 'fitHeight', 'contain', 'cover', 'stretch', 'none'], default: 'contain' },
                safeArea: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        rect: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } }, required: ['x', 'y', 'width', 'height'] },
                        insets: { type: 'object', additionalProperties: false, properties: { top: { type: 'number', minimum: 0 }, right: { type: 'number', minimum: 0 }, bottom: { type: 'number', minimum: 0 }, left: { type: 'number', minimum: 0 } }, required: ['top', 'right', 'bottom', 'left'] },
                        x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 },
                    },
                    oneOf: [{ required: ['rect'] }, { required: ['insets'] }, { required: ['x', 'y', 'width', 'height'] }],
                },
                maxNodes: { type: 'integer', minimum: 1, maximum: 5000, default: 128 },
                maxIssues: { type: 'integer', minimum: 1, maximum: 5000, default: 256 },
                checks: {
                    type: 'object', additionalProperties: false,
                    properties: { clipping: { type: 'boolean', default: true }, overlap: { type: 'boolean', default: true }, anchors: { type: 'boolean', default: true }, safeArea: { type: 'boolean', default: true } },
                },
            },
            oneOf: [
                {
                    required: ['reference'],
                    not: { anyOf: [{ required: ['root'] }, { required: ['rootPath'] }, { required: ['designResolution'] }, { required: ['viewport'] }, { required: ['safeArea'] }, { required: ['checks'] }] },
                },
                {
                    not: { required: ['reference'] },
                    oneOf: [{ required: ['root'] }, { required: ['rootPath'] }],
                    anyOf: [{ required: ['designResolution', 'viewport'] }, { required: ['safeArea'] }],
                },
            ],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                valid: { type: 'boolean' }, complete: { type: 'boolean' }, truncated: { type: 'boolean' },
                checkedNodes: { type: 'integer' }, root: { type: 'object' }, nodes: { type: 'array' }, issues: { type: 'array' },
                truncation: { type: 'array' }, geometry: { type: 'object' }, safeArea: { type: 'object' },
                error: { type: 'object', additionalProperties: false, required: ['code', 'message', 'evidence'], properties: { code: { type: 'string' }, message: { type: 'string' }, evidence: { type: 'object' } } },
            },
            oneOf: [
                { required: ['error'] },
                { required: ['valid', 'complete', 'truncated', 'checkedNodes', 'root', 'nodes', 'issues', 'truncation'] },
                { required: ['valid', 'issues', 'checkedNodes'] },
            ],
        },
        'POST',
        ['ui', 'layout', 'validate', 'geometry', 'diagnostics']
    )
    async uiLayoutValidate(args: ({ reference?: IInstanceReference } & UiLayoutValidateRequest)): Promise<UiLayoutValidateResult | { valid: boolean, issues: string[], checkedNodes: number }> {
        if (isCandidateRequest(args)) {
            return await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'ccp3x', method: 'uiLayoutValidate', args: [args],
            }) as UiLayoutValidateResult;
        }
        const legacyArgs = args as { reference?: IInstanceReference; maxNodes?: number };
        const inspected = await this.inspectLayout(legacyArgs.reference?.id, legacyArgs.maxNodes ?? 64);
        const issues: string[] = [];
        for (const item of inspected.nodes) {
            if (!item.size) issues.push(`${item.reference.id}: missing cc.UITransform`);
            if (item.size && (item.size.width < 0 || item.size.height < 0)) issues.push(`${item.reference.id}: negative layout size`);
        }
        return { valid: issues.length === 0 && !inspected.truncated, issues, checkedNodes: inspected.nodes.length };
    }

    @utcpTool(
        'uiCreateScrollView',
        'Create and verify a ScrollView with viewport mask and content hierarchy.',
        {
            type: 'object',
            properties: { name: { type: 'string', default: 'ScrollView' }, parentReference: InstanceReferenceSchema },
        },
        { type: 'object', properties: { reference: InstanceReferenceSchema, viewport: { type: 'object' }, content: { type: 'object' } }, required: ['reference', 'viewport', 'content'] },
        'POST',
        ['ui', 'scrollview', 'create', 'compound']
    )
    async uiCreateScrollView(args: { name?: string, parentReference?: IInstanceReference } = {}): Promise<{ reference: IInstanceReference, viewport: IInstanceReference, content: IInstanceReference }> {
        const root = await this.createUiNode({ uiType: 'ScrollView', name: args.name ?? 'ScrollView', parentReference: args.parentReference });
        try {
            const rootDump = await this.queryNodeDump(root.reference.id);
            const scroll = rootDump?.__comps__?.find(component => component.type === 'cc.ScrollView')?.value;
            if (!scroll) throw new Error('ScrollView component read-back is unavailable');
            const binding = this.unwrapValue(scroll.content ?? scroll._content);
            const contentUuid = this.childUuid(binding);
            const contentDump = await this.queryNodeDump(contentUuid);
            if (!contentDump || this.unwrapValue(contentDump.uuid) !== contentUuid) throw new Error('Bound content identity was not confirmed');
            const viewportUuid = this.childUuid(this.unwrapValue(contentDump.parent));
            const viewportDump = await this.queryNodeDump(viewportUuid);
            if (!viewportDump || this.unwrapValue(viewportDump.uuid) !== viewportUuid
                || !(rootDump?.children ?? []).some(child => this.childUuid(child) === viewportUuid)
                || !(viewportDump.children ?? []).some(child => this.childUuid(child) === contentUuid)
                || !(viewportDump.__comps__ ?? []).some(component => component.type === 'cc.Mask')) throw new Error('Bound ScrollView viewport/content hierarchy or mask was not confirmed');
            return { reference: root.reference, viewport: { id: viewportUuid, type: 'cc.Node' }, content: { id: contentUuid, type: 'cc.Node' } };
        } catch (error: unknown) {
            const rollback = await this.rollbackNode(root.reference.id);
            throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 502, message: `uiCreateScrollView hierarchy verification failed${rollback ? `; rollback failed: ${rollback}` : '; scroll view was rolled back'}.`, details: { createdNodeId: root.reference.id, cause: error instanceof Error ? error.message : String(error) }, recovery: rollback ? `Delete node ${root.reference.id} manually before retrying.` : 'Retry after the scene is ready.' });
        }
    }

    @utcpTool(
        'uiCreateInputForm',
        'Create a labeled input form row with focus-order metadata and verified controls.',
        {
            type: 'object',
            properties: { label: { type: 'string', minLength: 1 }, placeholder: { type: 'string' }, name: { type: 'string', default: 'InputForm' }, parentReference: InstanceReferenceSchema },
            required: ['label'],
        },
        { type: 'object', properties: { reference: InstanceReferenceSchema, label: { type: 'object' }, input: { type: 'object' }, submit: { type: 'object' }, focusOrder: { type: 'array' } }, required: ['reference', 'label', 'input', 'submit', 'focusOrder'] },
        'POST',
        ['ui', 'input', 'form', 'create', 'compound']
    )
    async uiCreateInputForm(args: { label: string, placeholder?: string, name?: string, parentReference?: IInstanceReference }): Promise<{ reference: IInstanceReference, label: IInstanceReference, input: IInstanceReference, submit: IInstanceReference, focusOrder: string[] }> {
        const form = await this.createUiNode({ uiType: 'Widget', name: args.name ?? 'InputForm', parentReference: args.parentReference });
        try {
        const label = await this.createLabel({ name: 'Label', text: args.label, parentReference: form.reference });
        const input = await this.createUiNode({ uiType: 'EditBox', name: 'Input', parentReference: form.reference });
        if (args.placeholder !== undefined) {
            const inputPath = await this.componentPath(input.reference.id, 'cc.EditBox');
            const accepted = await Editor.Message.request('scene', 'set-property', { uuid: input.reference.id, path: `${inputPath}.placeholder`, dump: { value: args.placeholder, type: 'cc.String' } });
            if (accepted === false) throw new Error('Creator refused EditBox placeholder');
            const inputDump = await this.queryNodeDump(input.reference.id);
            const editBox = inputDump?.__comps__?.find(component => component.type === 'cc.EditBox')?.value;
            if (!editBox || this.unwrapValue(editBox.placeholder) !== args.placeholder) throw new Error('EditBox placeholder read-back mismatch');
        }
        const submit = await this.createButton({ name: 'Submit', text: 'Submit', parentReference: form.reference });
        await Editor.Message.request('scene', 'snapshot');
        const dump = await this.queryNodeDump(form.reference.id);
        const children = new Set((dump?.children ?? []).map(child => this.childUuid(child)));
        if (!dump || ![label.reference.id, input.reference.id, submit.reference.id].every(id => children.has(id))) throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: 'uiCreateInputForm hierarchy verification failed' });
        return { reference: form.reference, label: label.reference, input: input.reference, submit: submit.reference, focusOrder: [input.reference.id, submit.reference.id] };
        } catch (error: unknown) {
            const rollback = await this.rollbackNode(form.reference.id);
            throw new ToolError({ code: rollback ? 'ROLLBACK_FAILED' : 'POSTCONDITION_FAILED', status: 502, message: rollback ? 'Input form creation failed and owned root cleanup was not confirmed.' : 'Input form creation failed; owned root absence was confirmed.', details: { createdNodeId: form.reference.id, cause: error instanceof Error ? error.message : String(error), rollback }, recovery: 'Inspect the owned form root before retrying; do not replay an ambiguous create.' });
        }
    }

    private unwrapValue(value: unknown): unknown {
        return this.isRecord(value) && 'value' in value ? value.value : value;
    }
    private validateUiLayoutInspectArgs(args: unknown): { rootUuid?: string, maxNodes: number } {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'uiLayoutInspect arguments must be an object.' });
        }
        const input = args as Record<string, unknown>;
        if (Object.keys(input).some((key) => key !== 'reference' && key !== 'maxNodes')) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'uiLayoutInspect accepts only reference and maxNodes.' });
        }
        let rootUuid: string | undefined;
        if (input.reference !== undefined) {
            const reference = input.reference;
            if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'uiLayoutInspect reference must be a typed cc.Node reference.' });
            }
            const typedReference = reference as Record<string, unknown>;
            if (Object.keys(typedReference).some((key) => key !== 'id' && key !== 'type')
                || typeof typedReference.id !== 'string' || typedReference.id.trim().length === 0 || typedReference.id.length > 256
                || (typedReference.type !== undefined && typedReference.type !== 'cc.Node')) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'uiLayoutInspect reference must contain a non-empty id of at most 256 characters and optional type cc.Node.' });
            }
            rootUuid = typedReference.id;
        }
        const maxNodes = input.maxNodes === undefined ? 64 : input.maxNodes;
        if (typeof maxNodes !== 'number' || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 128) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'uiLayoutInspect maxNodes must be an integer from 1 to 128.' });
        }
        return { rootUuid, maxNodes };
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    private finiteNumber(value: unknown, fallback: number): number {
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }

    private childUuid(entry: unknown): string {
        if (!this.isRecord(entry)) {
            throw new ToolError({ code: 'UI_LAYOUT_INVALID_RESPONSE', status: 502, message: 'uiLayoutInspect received a malformed child reference from Creator.' });
        }
        const direct = entry.uuid;
        const wrapped = this.isRecord(entry.value) ? entry.value.uuid : undefined;
        const id = typeof direct === 'string' ? direct : wrapped;
        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new ToolError({ code: 'UI_LAYOUT_INVALID_RESPONSE', status: 502, message: 'uiLayoutInspect received a child reference without a valid UUID from Creator.' });
        }
        return id;
    }

    private normalizeLayoutDump(id: string, dump: unknown, strict = true): SceneNodeDump {
        if (!strict) return dump as SceneNodeDump;
        if (!this.isRecord(dump) || this.unwrapValue(dump.uuid) !== id) {
            throw new ToolError({ code: 'UI_LAYOUT_INVALID_RESPONSE', status: 502, message: `uiLayoutInspect received a malformed node payload for ${id}.` });
        }
        if (dump.children !== undefined && !Array.isArray(dump.children)) {
            throw new ToolError({ code: 'UI_LAYOUT_INVALID_RESPONSE', status: 502, message: `uiLayoutInspect received malformed children for node ${id}.` });
        }
        if (dump.__comps__ !== undefined && !Array.isArray(dump.__comps__)) {
            throw new ToolError({ code: 'UI_LAYOUT_INVALID_RESPONSE', status: 502, message: `uiLayoutInspect received malformed components for node ${id}.` });
        }
        return dump as SceneNodeDump;
    }

    private async inspectLayout(rootUuid: string | undefined, maxNodes = 64, strict = false): Promise<{ nodes: UiLayoutNode[], truncated: boolean }> {
        this.validateUiLayoutInspectArgs({ reference: rootUuid === undefined ? undefined : { id: rootUuid }, maxNodes });
        let tree: unknown;
        try {
            tree = rootUuid
                ? await Editor.Message.request('scene', 'query-node-tree', rootUuid)
                : await Editor.Message.request('scene', 'query-node-tree');
        } catch (error: unknown) {
            if (!strict) throw error;
            throw new ToolError({
                code: 'UI_LAYOUT_QUERY_FAILED',
                status: 502,
                message: 'uiLayoutInspect could not query the Creator scene hierarchy.',
                details: { cause: error instanceof Error ? error.message : String(error) },
                recovery: 'Retry after the Creator scene is ready.',
            });
        }
        if (tree === null || tree === undefined) {
            throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'Scene subtree not found' });
        }
        if (!this.isRecord(tree) || typeof tree.uuid !== 'string' || tree.uuid.trim().length === 0 || (rootUuid !== undefined && tree.uuid !== rootUuid) || (tree.children !== undefined && !Array.isArray(tree.children))) {
            throw new ToolError({ code: 'UI_LAYOUT_INVALID_RESPONSE', status: 502, message: 'uiLayoutInspect received a malformed scene hierarchy from Creator.' });
        }

        const nodes: UiLayoutNode[] = [];
        const visited = new Set<string>();
        let truncated = false;
        const visit = async (id: string, orderedChildren?: unknown[]): Promise<void> => {
            if (visited.has(id)) return;
            if (nodes.length >= maxNodes) {
                truncated = true;
                return;
            }
            visited.add(id);

            let rawDump: unknown;
            try {
                rawDump = await this.queryNodeDump(id);
            } catch (error: unknown) {
                if (!strict) throw error;
                throw new ToolError({
                    code: 'UI_LAYOUT_QUERY_FAILED',
                    status: 502,
                    message: `uiLayoutInspect could not query node ${id}.`,
                    details: { cause: error instanceof Error ? error.message : String(error) },
                    recovery: 'Retry after the Creator scene is ready.',
                });
            }
            if (rawDump === null || rawDump === undefined) {
                throw new ToolError({ code: 'NOT_FOUND', status: 404, message: `UI node ${id} not found` });
            }
            const dump = this.normalizeLayoutDump(id, rawDump, strict);
            const pos = this.isRecord(this.unwrapValue(dump.position)) ? this.unwrapValue(dump.position) as Record<string, unknown> : {};
            const x = this.finiteNumber(pos.x, 0);
            const y = this.finiteNumber(pos.y, 0);
            const z = this.finiteNumber(pos.z, 0);
            const nameValue = typeof dump.name === 'string' ? dump.name : this.isRecord(dump.name) && typeof dump.name.value === 'string' ? dump.name.value : strict ? '' : id;
            const activeValue = this.unwrapValue(dump.active);
            const active = typeof activeValue === 'boolean' ? activeValue : true;
            nodes.push({
                reference: { id, type: 'cc.Node' },
                name: nameValue,
                active,
                position: { x, y, z },
                size: null,
                anchor: null,
                worldRect: null,
                components: (dump.__comps__ ?? []).filter((component): component is { type?: string } => this.isRecord(component)).map((component) => component.type).filter((type): type is string => typeof type === 'string'),
            });

            const children = orderedChildren ?? dump.children ?? [];
            for (const child of children) {
                const childId = this.childUuid(child);
                if (visited.has(childId)) continue;
                if (nodes.length >= maxNodes) {
                    truncated = true;
                    return;
                }
                if (this.isRecord(child) && 'children' in child && child.children !== undefined && !Array.isArray(child.children)) {
                    throw new ToolError({ code: 'UI_LAYOUT_INVALID_RESPONSE', status: 502, message: `uiLayoutInspect received malformed hierarchy children for node ${childId}.` });
                }
                const childChildren = this.isRecord(child) && Array.isArray(child.children) ? child.children : undefined;
                await visit(childId, childChildren);
            }
        };

        const sceneTree = tree as { uuid: string, children?: unknown[] };
        await visit(sceneTree.uuid, sceneTree.children);
        let geometry: unknown;
        try {
            geometry = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'ccp3x', method: 'uiLayoutInspectGeometry', args: [{ nodeIds: nodes.map((node) => node.reference.id) }],
            });
        } catch (error: unknown) {
            throw new ToolError({ code: 'UI_LAYOUT_QUERY_FAILED', status: 502, message: 'Could not read live UI geometry.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
        if (this.isRecord(geometry) && this.isRecord(geometry.error) && typeof geometry.error.code === 'string' && typeof geometry.error.message === 'string') {
            throw new ToolError({ code: geometry.error.code, status: geometry.error.code === 'NOT_FOUND' ? 404 : 502, message: geometry.error.message });
        }
        if (!this.isRecord(geometry) || !Array.isArray(geometry.nodes) || geometry.nodes.length !== nodes.length) {
            throw new ToolError({ code: 'UI_LAYOUT_INVALID_RESPONSE', status: 502, message: 'Creator returned an incomplete live geometry inventory.' });
        }
        for (let index = 0; index < nodes.length; index++) {
            const live = geometry.nodes[index];
            if (!isUiLayoutGeometry(live, nodes[index].reference.id)) {
                throw new ToolError({ code: 'UI_LAYOUT_INVALID_RESPONSE', status: 502, message: 'Creator returned malformed or mismatched live geometry.' });
            }
            nodes[index].size = live.size === null ? null : { width: live.size.width, height: live.size.height };
            nodes[index].anchor = live.anchor === null ? null : { x: live.anchor.x, y: live.anchor.y };
            nodes[index].worldRect = live.worldRect === null ? null : { x: live.worldRect.x, y: live.worldRect.y, width: live.worldRect.width, height: live.worldRect.height };
        }
        return { nodes, truncated };
    }
    private async queryNodeDump(uuid: string): Promise<SceneNodeDump | null> {
        return await Editor.Message.request('scene', 'query-node', uuid) as unknown as SceneNodeDump | null;
    }
    private async componentPath(uuid: string, componentType: string): Promise<string> {
        for (let attempt = 0; attempt < 5; attempt++) {
            const node = await this.queryNodeDump(uuid);
            const index = node?.__comps__?.findIndex((component) => component.type === componentType) ?? -1;
            if (index >= 0) return `__comps__.${index}`;
            if (attempt < 4) {
                await new Promise<void>((resolve) => setTimeout(resolve, 40));
            }
        }
        throw new Error(`Component ${componentType} not found on node ${uuid}`);
    }
    private async findNamedChild(node: SceneNodeDump | null, name: string): Promise<string | null> {
        for (const child of node?.children ?? []) {
            let uuid: string;
            try {
                uuid = this.childUuid(child);
            } catch {
                continue;
            }
            const childDump = await this.queryNodeDump(uuid);
            const childName = typeof childDump?.name === 'string' ? childDump.name : childDump?.name?.value;
            if (childName === name) return uuid;
        }
        return null;
    }


    private async createNativeLabelChild(parentUuid: string): Promise<string | null> {
        const result = await Editor.Message.request('scene', 'create-node', {
            name: 'Label',
            parent: parentUuid,
        });
        const childUuid = Array.isArray(result) ? result[0] : result;
        if (typeof childUuid !== 'string' || !childUuid) return null;
        await ensureSceneComponents(childUuid, ['cc.Label', 'cc.UITransform']);
        await Editor.Message.request('scene', 'snapshot');
        return childUuid;
    }

    /**
     * Best-effort undo for a partially applied create* helper: remove the node we
     * just created and snapshot the scene. Returns null when the node is gone, or
     * the rollback error message so the caller can tell the agent to delete it
     * manually before retrying (a leaked half-configured node is worse than a throw).
     */
    private async rollbackNode(uuid: string): Promise<string | null> {
        try {
            let removalError: unknown;
            try { await Editor.Message.request('scene', 'remove-node', { uuid }); }
            catch (error) { removalError = error; }
            try { await Editor.Message.request('scene', 'snapshot'); } catch { /* Absence must still be inspected independently. */ }
            const remaining = await Editor.Message.request('scene', 'query-node', uuid);
            if (remaining !== null && remaining !== undefined) return removalError instanceof Error ? removalError.message : 'Owned node absence was not confirmed.';
            return null;
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    }
}
