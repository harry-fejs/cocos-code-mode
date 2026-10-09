// Event simulation — fire or attach handlers on cc.Button via the live scene.
// Delegates to scene.ts helpers; the scene panel is the only context where the
// runtime node graph + EventHandler are live.
import { utcpTool } from '../decorators';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { ToolError } from '../tool-error';

const EVENT_PACKAGE = 'ccp3x';

async function ensureRuntimeNode(id: string): Promise<void> {
    const exists = await Editor.Message.request('scene', 'query-node', id);
    if (exists === null || exists === undefined) {
        throw new ToolError({
            code: 'NOT_FOUND',
            status: 404,
            message: `Node ${id} not found in editor scene`,
            details: { id },
            recovery: 'Pass a current scene node reference.',
        });
    }
}

export class EventTools {

    @utcpTool(
        'simulateButtonClick',
        'Simulate a button click: finds cc.Button on the runtime node and fires its clickEvents (same path the UI uses).',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
            },
            required: ['reference'],
        },
        {
            type: 'object',
            properties: {
                handlersFired: { type: 'number' },
                method: { type: 'string' },
            },
            required: ['handlersFired'],
        },
        'POST',
        ['event', 'button', 'click', 'simulate', 'input', 'interact']
    )
    async simulateButtonClick(args: { reference: IInstanceReference }): Promise<{ handlersFired: number, method: string }> {
        if (!args.reference?.id) throw new Error('simulateButtonClick requires reference.id (node uuid with cc.Button)');
        await ensureRuntimeNode(args.reference.id);
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: EVENT_PACKAGE, method: 'simulateButtonClick', args: [args.reference.id],
        }) as { handlersFired: number, method: string } | null;
        if (typeof result?.handlersFired !== 'number') throw new Error(`simulateButtonClick: unexpected response ${JSON.stringify(result)}`);
        return { handlersFired: result.handlersFired, method: result.method ?? 'clickEvents' };
    }

    @utcpTool(
        'bindButtonClickEvent',
        'Attach a cc.EventHandler to a Button: on click, calls componentType.handlerName on the same node (or its children).',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                componentType: { type: 'string', description: 'Target component type, e.g. "WheelController" or "cc.Component"' },
                handlerName:   { type: 'string', description: 'Method name on that component' },
                customEventData: { type: 'string', description: 'Optional customEventData forwarded to the handler' },
            },
            required: ['reference', 'componentType', 'handlerName'],
        },
        {
            type: 'object',
            properties: {
                handlerCount: { type: 'number' },
            },
            required: ['handlerCount'],
        },
        'POST',
        ['event', 'button', 'bind', 'handler', 'component', 'interact']
    )
    async bindButtonClickEvent(args: {
        reference: IInstanceReference, componentType: string, handlerName: string, customEventData?: string
    }): Promise<{ handlerCount: number }> {
        if (!args.reference?.id) throw new Error('bindButtonClickEvent requires reference.id');
        if (!args.componentType?.trim()) throw new Error('componentType must be non-empty');
        if (!args.handlerName?.trim())   throw new Error('handlerName must be non-empty');
        await ensureRuntimeNode(args.reference.id);
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: EVENT_PACKAGE, method: 'bindButtonClickEvent',
            args: [args.reference.id, args.componentType, args.handlerName, args.customEventData || ''],
        }) as { handlerCount: number } | null;
        if (typeof result?.handlerCount !== 'number' || result.handlerCount === 0) throw new Error(`bindButtonClickEvent: unexpected response ${JSON.stringify(result)}`);
        return { handlerCount: result.handlerCount };
    }
    @utcpTool(
        'listButtonClickEvents',
        'List serialized cc.Button click-event bindings without executing handlers.',
        { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] },
        { type: 'array', items: { type: 'object', properties: { targetUuid: { type: ['string', 'null'] }, componentName: { type: ['string', 'null'] }, handler: { type: ['string', 'null'] }, customEventData: { type: 'string' } }, required: ['targetUuid', 'componentName', 'handler', 'customEventData'] } },
        'GET', ['event', 'button', 'click', 'list', 'inspect']
    )
    async listButtonClickEvents(args: { reference: IInstanceReference }): Promise<Array<{ targetUuid: string | null, componentName: string | null, handler: string | null, customEventData: string }>> {
        if (!args.reference?.id) throw new Error('listButtonClickEvents requires reference.id');
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: EVENT_PACKAGE, method: 'listButtonClickEvents', args: [args.reference.id],
        });
        if (!Array.isArray(result)) throw new Error(`listButtonClickEvents: unexpected response ${JSON.stringify(result)}`);
        return result as Array<{ targetUuid: string | null, componentName: string | null, handler: string | null, customEventData: string }>;
    }
}
