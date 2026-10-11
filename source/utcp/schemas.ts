import { JsonSchema } from '@utcp/sdk';

// -=-=-=-=-=- interfaces for different result types -=-=-=-=-=-

export interface IBase64Image {
    type: "image";
    data: string;
    mimeType: string;
}

export interface IBase64Audio {
    type: "audio";
    data: string;
    mimeType: string;
}

export interface ISuccessIndicator {
    success: boolean;
    error?: string;
}

export interface IInstanceReference {
    id: string;
    type?: string;
}

export interface IAssetTreeItem {
    filesystemPath?: string;
    reference: IInstanceReference;
    name: string;
    children: Array<IAssetTreeItem>;
}

export interface ISceneTreeItem {
    path?: string;
    reference: IInstanceReference;
    name?: string;
    active?: boolean;
    components?: Array<IInstanceReference>;
    children: Array<ISceneTreeItem>;
    truncated?: 'maxDepth' | 'nodeLimit';
    childrenOmitted?: number;
    childrenCount?: number;
    childOffset?: number;
    pageSize?: number;
    nextOffset?: number | null;
    revision?: string;
}

// -=-=-=-=-=- Zod schemas for different result types -=-=-=-=-=-

export const InstanceReferenceSchema: JsonSchema = { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' } }, required: ['id'] };
export const SuccessIndicatorSchema: JsonSchema = { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string'} }, required: ['success'] };
export const Base64ImageSchema: JsonSchema = { type: 'object', properties: { type: { type: 'string', const: "image" }, data: { type: 'string' }, mimeType: { type: 'string' } }, required: ['type', 'data', 'mimeType'] };

export const AssetTreeItemSchema: JsonSchema = {
    type: 'object',
    properties: {
        filesystemPath: { type: 'string'},
        reference: InstanceReferenceSchema,
        name: { type: 'string' },
        children: { type: 'array', items: { type: 'object' } }
    }, required: ['reference', 'name', 'children']
};

export const SceneTreeItemSchema: JsonSchema = {
    type: 'object',
    properties: {
        path: { type: 'string' },
        reference: InstanceReferenceSchema,
        name: { type: 'string' },
        active: { type: 'boolean' },
        components: {
            type: 'array',
            items: InstanceReferenceSchema
        },
        children: { type: 'array', items: { type: 'object' } },
        truncated: { type: 'string', enum: ['maxDepth', 'nodeLimit'] },
        childrenOmitted: { type: 'integer', minimum: 0 },
        childrenCount: { type: 'integer', minimum: 0 },
        childOffset: { type: 'integer', minimum: 0 },
        pageSize: { type: 'integer', minimum: 1 },
        nextOffset: { type: ['integer', 'null'], minimum: 0 },
        revision: { type: 'string', minLength: 1 }
    }, required: ['reference', 'children']
};