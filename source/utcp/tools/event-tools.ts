// Event simulation — fire or attach handlers on cc.Button via the live scene.
// Delegates to scene.ts helpers; the scene panel is the only context where the
// runtime node graph + EventHandler are live.
import { utcpTool } from '../decorators';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';

const EVENT_PACKAGE = 'ccp3x';

async function ensureRuntimeNode(id: string): Promise<void> {
    const exists = await Editor.Message.request('scene', 'query-node', id);
    if (exists === null || exists === undefined) {
        throw new Error(`Node ${id} not found in editor scene`);
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

}
