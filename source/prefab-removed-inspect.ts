interface PrefabComponent { __prefab?: { fileId?: string }; constructor?: unknown }
interface PrefabNode {
    uuid: string; children: PrefabNode[]; components: PrefabComponent[]; parent?: PrefabNode | null;
    _prefab?: { fileId?: string; root?: PrefabNode; asset?: { _uuid: string; data?: PrefabNode }; instance?: { removedComponents?: Array<{ localID?: unknown }> } };
}

export function inspectRemovedPrefabIdentity(node: unknown, request: { nodeUuid: string; fileID: string }, className: (component: unknown) => string): Record<string, unknown> {
    if (!node || typeof node !== 'object' || !request.fileID || request.fileID.length > 256) throw new Error('Invalid prefab removal target.');
    // Internal engine objects are resolved by the existing scene resolver, not external JSON.
    const target = node as PrefabNode;
    if (target.uuid !== request.nodeUuid || !target._prefab?.asset) throw new Error('Target is not the selected linked prefab node.');
    let scope: PrefabNode | null | undefined = target;
    let depth = 0;
    while (scope && !scope._prefab?.instance && depth++ < 32) scope = scope.parent;
    if (!scope?._prefab?.instance) throw new Error('Prefab instance override scope is unavailable.');
    const raw = scope._prefab.instance.removedComponents ?? [];
    if (raw.length > 128) throw new Error('Removed component collection exceeds its inspection bound.');
    const removedComponents = raw.map(entry => {
        if (!Array.isArray(entry.localID) || entry.localID.length < 1 || entry.localID.length > 16 || entry.localID.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('Invalid native removed component target identity.');
        return { localID: entry.localID as string[] };
    });
    const matches = removedComponents.filter(entry => entry.localID[entry.localID.length - 1] === request.fileID);
    if (matches.length > 1) throw new Error('Removed component selector is ambiguous.');
    if (!matches.length) return { nodeUUID: target.uuid, fileID: request.fileID, selected: null, removedComponents, instanceRootUUID: scope.uuid, rootSourceAssetUUID: scope._prefab.asset?._uuid };
    const asset = target._prefab.asset;
    if (!asset.data) throw new Error('Prefab source data is unavailable.');
    const stack = [asset.data];
    let visited = 0;
    let selected: Record<string, unknown> | null = null;
    while (stack.length) {
        const sourceNode = stack.pop()!;
        if (++visited > 256) throw new Error('Prefab source inspection exceeds its bound.');
        for (const component of sourceNode.components ?? []) {
            if (component.__prefab?.fileId !== request.fileID) continue;
            if (selected) throw new Error('Source component identity is ambiguous.');
            if (sourceNode._prefab?.fileId !== target._prefab.fileId) throw new Error('Removed component belongs to a different prefab source node.');
            selected = { localID: matches[0].localID, sourceAssetUUID: asset._uuid, ownerFileID: sourceNode._prefab?.fileId, componentType: className(component) };
        }
        stack.push(...(sourceNode.children ?? []));
    }
    if (!selected) throw new Error('Removed component does not resolve to the linked prefab source.');
    return { nodeUUID: target.uuid, fileID: request.fileID, selected, removedComponents, instanceRootUUID: scope.uuid, rootSourceAssetUUID: scope._prefab.asset?._uuid };
}
