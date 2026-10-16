import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { ToolError } from './utcp/tool-error';

export const COMPONENT_PROPERTY_TYPES = ['enum', 'integer', 'number', 'string', 'boolean', 'Vec2', 'Vec3', 'Vec4', 'Size', 'Rect', 'Quat', 'Color', 'Node', 'UITransform', 'Layout', 'Widget', 'Mask', 'Canvas', 'Label', 'Sprite', 'Button', 'EditBox', 'ScrollView', 'Slider', 'Toggle', 'ProgressBar', 'AudioSource', 'Animation', 'Camera', 'MeshRenderer', 'SkinnedMeshRenderer', 'ParticleSystem', 'ParticleSystem2D', 'SkeletalAnimation', 'AudioClip', 'AnimationClip', 'SpriteFrame', 'Prefab', 'Material', 'JsonAsset', 'TextAsset', 'Texture2D', 'Font', 'TTFFont', 'BitmapFont', 'SpriteAtlas', 'SceneAsset', 'Mesh', 'Skeleton', 'RigidBody', 'Collider', 'RigidBody2D', 'Collider2D', 'BoxCollider', 'SphereCollider', 'CapsuleCollider', 'MeshCollider', 'BoxCollider2D', 'CircleCollider2D', 'PolygonCollider2D', 'UIOpacity', 'RichText', 'ToggleContainer', 'PageView', 'PageViewIndicator', 'ScrollBar', 'SafeArea', 'BlockInputEvents', 'UICoordinateTracker', 'HingeConstraint', 'FixedConstraint', 'PointToPointConstraint', 'DistanceJoint2D', 'SpringJoint2D', 'FixedJoint2D', 'HingeJoint2D', 'MouseJoint2D', 'RelativeJoint2D', 'SliderJoint2D', 'WheelJoint2D', 'ImageAsset', 'TextureCube', 'EffectAsset', 'PhysicsMaterial'] as const;
export type ComponentPropertyType = typeof COMPONENT_PROPERTY_TYPES[number];
export const REQUIRED_COMPONENT_TYPES = ['UITransform', 'Layout', 'Widget', 'Mask', 'Canvas', 'Label', 'Sprite', 'Button', 'EditBox', 'ScrollView', 'Slider', 'Toggle', 'ProgressBar', 'AudioSource', 'Animation', 'Camera', 'MeshRenderer', 'SkinnedMeshRenderer', 'ParticleSystem', 'ParticleSystem2D', 'SkeletalAnimation', 'UIOpacity', 'RichText', 'ToggleContainer', 'PageView', 'PageViewIndicator', 'ScrollBar', 'SafeArea', 'BlockInputEvents', 'UICoordinateTracker', 'RigidBody', 'RigidBody2D', 'BoxCollider', 'SphereCollider', 'CapsuleCollider', 'MeshCollider', 'BoxCollider2D', 'CircleCollider2D', 'PolygonCollider2D'] as const;
export type RequiredComponentType = typeof REQUIRED_COMPONENT_TYPES[number];
export type ComponentPropertyDescriptor = { animatable?: boolean; editorOnly?: boolean; serializable?: boolean; formerlySerializedAs?: string; tooltip?: string; displayName?: string; group?: string; visible?: boolean; readOnly?: boolean; displayOrder?: number } & (
    | { name: string; type: 'number'; array?: false; default?: number; range?: { min: number; max: number; slider?: boolean; step?: number } }
    | { name: string; type: 'integer'; array?: false; default?: number; range?: { min: number; max: number; slider?: boolean; step?: number } }
    | { name: string; type: 'enum'; array?: false; entries: Array<{ name: string; value: number }>; default: number }
    | { name: string; type: 'enum'; array: true; entries: Array<{ name: string; value: number }>; default?: number[] }
    | { name: string; type: 'string'; array?: false; default?: string; multiline?: boolean }
    | { name: string; type: 'boolean'; array?: false; default?: boolean }
    | { name: string; type: 'Vec2'; array?: false; default?: { x: number; y: number } }
    | { name: string; type: 'Vec3'; array?: false; default?: { x: number; y: number; z: number } }
    | { name: string; type: 'Vec4'; array?: false; default?: { x: number; y: number; z: number; w: number } }
    | { name: string; type: 'Size'; array?: false; default?: { width: number; height: number } }
    | { name: string; type: 'Rect'; array?: false; default?: { x: number; y: number; width: number; height: number } }
    | { name: string; type: 'Quat'; array?: false; default?: { x: number; y: number; z: number; w: number } }
    | { name: string; type: 'Color'; array?: false; default?: { r: number; g: number; b: number; a: number } }
    | { name: string; type: 'Node' | 'UITransform' | 'Layout' | 'Widget' | 'Mask' | 'Canvas' | 'Label' | 'Sprite' | 'Button' | 'EditBox' | 'ScrollView' | 'Slider' | 'Toggle' | 'ProgressBar' | 'AudioSource' | 'Animation' | 'Camera' | 'MeshRenderer' | 'SkinnedMeshRenderer' | 'ParticleSystem' | 'ParticleSystem2D' | 'SkeletalAnimation' | 'AudioClip' | 'AnimationClip' | 'SpriteFrame' | 'Prefab' | 'Material' | 'JsonAsset' | 'TextAsset' | 'Texture2D' | 'Font' | 'TTFFont' | 'BitmapFont' | 'SpriteAtlas' | 'SceneAsset' | 'Mesh' | 'Skeleton' | 'RigidBody' | 'Collider' | 'RigidBody2D' | 'Collider2D' | 'BoxCollider' | 'SphereCollider' | 'CapsuleCollider' | 'MeshCollider' | 'BoxCollider2D' | 'CircleCollider2D' | 'PolygonCollider2D' | 'UIOpacity' | 'RichText' | 'ToggleContainer' | 'PageView' | 'PageViewIndicator' | 'ScrollBar' | 'SafeArea' | 'BlockInputEvents' | 'UICoordinateTracker' | 'HingeConstraint' | 'FixedConstraint' | 'PointToPointConstraint' | 'DistanceJoint2D' | 'SpringJoint2D' | 'FixedJoint2D' | 'HingeJoint2D' | 'MouseJoint2D' | 'RelativeJoint2D' | 'SliderJoint2D' | 'WheelJoint2D' | 'ImageAsset' | 'TextureCube' | 'EffectAsset' | 'PhysicsMaterial'; array?: false; default?: null }
    | { name: string; type: 'number'; array: true; default?: number[] }
    | { name: string; type: 'integer'; array: true; default?: number[] }
    | { name: string; type: 'string'; array: true; default?: string[] }
    | { name: string; type: 'boolean'; array: true; default?: boolean[] }
    | { name: string; type: 'Vec2'; array: true; default?: { x: number; y: number }[] }
    | { name: string; type: 'Vec3'; array: true; default?: { x: number; y: number; z: number }[] }
    | { name: string; type: 'Vec4'; array: true; default?: { x: number; y: number; z: number; w: number }[] }
    | { name: string; type: 'Size'; array: true; default?: { width: number; height: number }[] }
    | { name: string; type: 'Rect'; array: true; default?: { x: number; y: number; width: number; height: number }[] }
    | { name: string; type: 'Quat'; array: true; default?: { x: number; y: number; z: number; w: number }[] }
    | { name: string; type: 'Color'; array: true; default?: { r: number; g: number; b: number; a: number }[] }
    | { name: string; type: 'Node' | 'UITransform' | 'Layout' | 'Widget' | 'Mask' | 'Canvas' | 'Label' | 'Sprite' | 'Button' | 'EditBox' | 'ScrollView' | 'Slider' | 'Toggle' | 'ProgressBar' | 'AudioSource' | 'Animation' | 'Camera' | 'MeshRenderer' | 'SkinnedMeshRenderer' | 'ParticleSystem' | 'ParticleSystem2D' | 'SkeletalAnimation' | 'AudioClip' | 'AnimationClip' | 'SpriteFrame' | 'Prefab' | 'Material' | 'JsonAsset' | 'TextAsset' | 'Texture2D' | 'Font' | 'TTFFont' | 'BitmapFont' | 'SpriteAtlas' | 'SceneAsset' | 'Mesh' | 'Skeleton' | 'RigidBody' | 'Collider' | 'RigidBody2D' | 'Collider2D' | 'BoxCollider' | 'SphereCollider' | 'CapsuleCollider' | 'MeshCollider' | 'BoxCollider2D' | 'CircleCollider2D' | 'PolygonCollider2D' | 'UIOpacity' | 'RichText' | 'ToggleContainer' | 'PageView' | 'PageViewIndicator' | 'ScrollBar' | 'SafeArea' | 'BlockInputEvents' | 'UICoordinateTracker' | 'HingeConstraint' | 'FixedConstraint' | 'PointToPointConstraint' | 'DistanceJoint2D' | 'SpringJoint2D' | 'FixedJoint2D' | 'HingeJoint2D' | 'MouseJoint2D' | 'RelativeJoint2D' | 'SliderJoint2D' | 'WheelJoint2D' | 'ImageAsset' | 'TextureCube' | 'EffectAsset' | 'PhysicsMaterial'; array: true; default?: [] });
export interface ComponentScriptDescriptor { className: string; menu?: string; executionOrder?: number; disallowMultiple?: boolean; properties?: ComponentPropertyDescriptor[]; requiredComponents?: RequiredComponentType[] }
export interface ComponentScriptSource { source: string; sha256: string; bytes: number; className: string }
export interface ComponentScriptPath { assetUrl: string; file: string; parentUrl: string; parent: string }
export interface ComponentScriptAsset { uuid: string; url: string; file: string; isDirectory?: boolean }
const MAX_SOURCE_BYTES = 64 * 1024;
const RESERVED: Record<string, boolean> = Object.fromEntries(('abstract any as asserts async await bigint boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get global if implements import in infer instanceof interface intrinsic is keyof let module namespace never new null number object of out override package private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield arguments eval _decorator Component Node AudioClip AnimationClip SpriteFrame CCFloat CCString CCBoolean ccclass property').split(' ').map(name => [name, true]));
const COMPONENT_MEMBERS: Record<string, boolean> = Object.fromEntries(('name uuid node enabled enabledInHierarchy isValid hideFlags addComponent getComponent getComponents getComponentInChildren getComponentsInChildren destroy schedule scheduleOnce unschedule unscheduleAllCallbacks onLoad start update lateUpdate onEnable onDisable onDestroy resetInEditor onFocusInEditor onLostFocusInEditor onRestore toString toLocaleString valueOf hasOwnProperty isPrototypeOf propertyIsEnumerable').split(' ').map(name => [name, true]));
const PROPERTY_IMPORTS: Record<ComponentPropertyType, string> = { enum: 'Enum', integer: 'CCInteger', number: 'CCFloat', string: 'CCString', boolean: 'CCBoolean', Vec2: 'Vec2', Vec3: 'Vec3', Vec4: 'Vec4', Size: 'Size', Rect: 'Rect', Quat: 'Quat', Color: 'Color', Node: 'Node', UITransform: 'UITransform', Layout: 'Layout', Widget: 'Widget', Mask: 'Mask', Canvas: 'Canvas', Label: 'Label', Sprite: 'Sprite', Button: 'Button', EditBox: 'EditBox', ScrollView: 'ScrollView', Slider: 'Slider', Toggle: 'Toggle', ProgressBar: 'ProgressBar', AudioSource: 'AudioSource', Animation: 'Animation', Camera: 'Camera', MeshRenderer: 'MeshRenderer', SkinnedMeshRenderer: 'SkinnedMeshRenderer', ParticleSystem: 'ParticleSystem', ParticleSystem2D: 'ParticleSystem2D', SkeletalAnimation: 'SkeletalAnimation', AudioClip: 'AudioClip', AnimationClip: 'AnimationClip', SpriteFrame: 'SpriteFrame', Prefab: 'Prefab', Material: 'Material', JsonAsset: 'JsonAsset', TextAsset: 'TextAsset', Texture2D: 'Texture2D', Font: 'Font', TTFFont: 'TTFFont', BitmapFont: 'BitmapFont', SpriteAtlas: 'SpriteAtlas', SceneAsset: 'SceneAsset', Mesh: 'Mesh', Skeleton: 'Skeleton', RigidBody: 'RigidBody', Collider: 'Collider', RigidBody2D: 'RigidBody2D', Collider2D: 'Collider2D', BoxCollider: 'BoxCollider', SphereCollider: 'SphereCollider', CapsuleCollider: 'CapsuleCollider', MeshCollider: 'MeshCollider', BoxCollider2D: 'BoxCollider2D', CircleCollider2D: 'CircleCollider2D', PolygonCollider2D: 'PolygonCollider2D', UIOpacity: 'UIOpacity', RichText: 'RichText', ToggleContainer: 'ToggleContainer', PageView: 'PageView', PageViewIndicator: 'PageViewIndicator', ScrollBar: 'ScrollBar', SafeArea: 'SafeArea', BlockInputEvents: 'BlockInputEvents', UICoordinateTracker: 'UICoordinateTracker', HingeConstraint: 'HingeConstraint', FixedConstraint: 'FixedConstraint', PointToPointConstraint: 'PointToPointConstraint', DistanceJoint2D: 'DistanceJoint2D', SpringJoint2D: 'SpringJoint2D', FixedJoint2D: 'FixedJoint2D', HingeJoint2D: 'HingeJoint2D', MouseJoint2D: 'MouseJoint2D', RelativeJoint2D: 'RelativeJoint2D', SliderJoint2D: 'SliderJoint2D', WheelJoint2D: 'WheelJoint2D', ImageAsset: 'ImageAsset', TextureCube: 'TextureCube', EffectAsset: 'EffectAsset', PhysicsMaterial: 'PhysicsMaterial' };
function invalid(message: string): never { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message }); }
export function assertComponentScriptInput(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('Component script input must be an object containing only supported fields.');
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && RESERVED[value] !== true; }
function literal(value: string | number | boolean | null): string { return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
export function componentScriptHash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

/** Deterministic data-component authoring only; never evaluates source or invokes lifecycle methods. */
export function generateComponentScriptSource(input: unknown): ComponentScriptSource {
    assertComponentScriptInput(input, ['className', 'properties', 'requiredComponents', 'disallowMultiple', 'menu', 'executionOrder']);
    if (!identifier(input.className)) invalid('className must be a non-reserved ASCII identifier of 1 to 64 characters beginning with a letter.');
    if (input.disallowMultiple !== undefined && typeof input.disallowMultiple !== 'boolean') invalid('disallowMultiple must be a boolean.');
    if (input.menu !== undefined && (typeof input.menu !== 'string' || !input.menu.trim() || input.menu.length > 256)) invalid('menu must be a nonblank path of at most 256 characters.');
    if (input.executionOrder !== undefined && (typeof input.executionOrder !== 'number' || !Number.isSafeInteger(input.executionOrder) || input.executionOrder < -2147483648 || input.executionOrder > 2147483647)) invalid('executionOrder must be a signed int32.');
    const rows = input.properties === undefined ? [] : input.properties;
    if (!Array.isArray(rows) || rows.length > 64) invalid('properties must contain at most 64 typed field descriptors.');
    const imports = new Set<string>(['_decorator', 'Component']);
    const required = input.requiredComponents === undefined ? [] : input.requiredComponents;
    if (!Array.isArray(required) || required.length > 8) invalid('requiredComponents must contain at most 8 unique supported native component types.');
    const dependencies = new Set<string>();
    for (const name of required) {
        if (typeof name !== 'string' || !REQUIRED_COMPONENT_TYPES.includes(name as RequiredComponentType) || dependencies.has(name)) invalid('requiredComponents must be dense, unique supported native component types.');
        dependencies.add(name); imports.add(name);
    }
    const names = new Set<string>();
    const fields: string[] = [];
    const aliases = new Set<string>();
    for (const row of rows) {
        assertComponentScriptInput(row, ['name', 'type', 'array', 'default', 'entries', 'tooltip', 'displayName', 'range', 'group', 'visible', 'readOnly', 'displayOrder', 'multiline', 'formerlySerializedAs', 'serializable', 'editorOnly', 'animatable']);
        if (!identifier(row.name) || COMPONENT_MEMBERS[row.name] === true || names.has(row.name)) invalid('Property names must be unique safe identifiers and must not shadow Component members or lifecycle methods.');
        if (aliases.has(row.name)) invalid('Property names must not collide with serialized aliases.');
        if (row.formerlySerializedAs !== undefined) {
            const alias = row.formerlySerializedAs;
            if (typeof alias !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(alias) || alias === '__proto__' || COMPONENT_MEMBERS[alias] === true || alias === row.name || aliases.has(alias) || names.has(alias)) invalid('formerlySerializedAs must be a unique safe prior field name distinct from all current fields.');
            aliases.add(alias);
        }
        if (typeof row.type !== 'string' || !COMPONENT_PROPERTY_TYPES.includes(row.type as ComponentPropertyType)) invalid('Unsupported property type.');
        const type = row.type as ComponentPropertyType;
        const hasDefault = Object.prototype.hasOwnProperty.call(row, 'default');
        if (row.array !== undefined && typeof row.array !== 'boolean') invalid('array must be a boolean when provided.');
        if (row.serializable !== undefined && typeof row.serializable !== 'boolean') invalid('serializable must be a boolean.');
        if (row.editorOnly !== undefined && typeof row.editorOnly !== 'boolean') invalid('editorOnly must be a boolean.');
        if (row.animatable !== undefined && typeof row.animatable !== 'boolean') invalid('animatable must be a boolean.');
        if (row.serializable === false && row.formerlySerializedAs !== undefined) invalid('Nonserialized fields cannot declare a prior serialized name.');
        if (row.tooltip !== undefined && (typeof row.tooltip !== 'string' || row.tooltip.length > 1024)) invalid('tooltip must be a string of at most 1024 characters.');
        if (row.displayName !== undefined && (typeof row.displayName !== 'string' || row.displayName.length > 256)) invalid('displayName must be a string of at most 256 characters.');
        if (row.group !== undefined && (typeof row.group !== 'string' || !row.group.trim() || row.group.length > 256)) invalid('group must be a nonblank string of at most 256 characters.');
        for (const key of ['visible', 'readOnly']) if (row[key] !== undefined && typeof row[key] !== 'boolean') invalid(`${key} must be a boolean.`);
        if (row.displayOrder !== undefined && (typeof row.displayOrder !== 'number' || !Number.isFinite(row.displayOrder))) invalid('displayOrder must be a finite number.');
        if (row.multiline !== undefined && (type !== 'string' || row.array === true || typeof row.multiline !== 'boolean')) invalid('multiline must be a boolean on scalar string fields only.');
        const tooltip = (row.tooltip === undefined ? '' : `, tooltip: ${literal(row.tooltip as string)}`) + (row.displayName === undefined ? '' : `, displayName: ${literal(row.displayName as string)}`) + (row.group === undefined ? '' : `, group: ${literal(row.group as string)}`) + (row.visible === undefined ? '' : `, visible: ${literal(row.visible as boolean)}`) + (row.readOnly === undefined ? '' : `, readonly: ${literal(row.readOnly as boolean)}`) + (row.displayOrder === undefined ? '' : `, displayOrder: ${literal(row.displayOrder as number)}`) + (row.multiline === undefined ? '' : `, multiline: ${literal(row.multiline as boolean)}`) + (row.formerlySerializedAs === undefined ? '' : `, formerlySerializedAs: ${literal(row.formerlySerializedAs as string)}`) + (row.serializable === undefined ? '' : `, serializable: ${literal(row.serializable as boolean)}`) + (row.editorOnly === undefined ? '' : `, editorOnly: ${literal(row.editorOnly as boolean)}`) + (row.animatable === undefined ? '' : `, animatable: ${literal(row.animatable as boolean)}`);
        let numericOptions = '';
        if (row.range !== undefined) {
            if (row.array === true || type !== 'number' && type !== 'integer') invalid('range is supported only on scalar number/integer fields.');
            assertComponentScriptInput(row.range, ['min', 'max', 'step', 'slider']);
            const { min, max, step, slider } = row.range;
            if (typeof min !== 'number' || !Number.isFinite(min) || typeof max !== 'number' || !Number.isFinite(max) || min > max || step !== undefined && (typeof step !== 'number' || !Number.isFinite(step) || step <= 0)) invalid('range requires finite min <= max and an optional positive finite step.');
            if (type === 'integer' && (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || step !== undefined && !Number.isSafeInteger(step))) invalid('Integer ranges require safe integer bounds and step.');
            if (slider !== undefined && typeof slider !== 'boolean' || slider === true && min === max) invalid('slider must be a boolean; enabled sliders require min < max.');
            const initialValue = hasDefault ? row.default : 0;
            if (typeof initialValue !== 'number' || !Number.isFinite(initialValue) || initialValue < min || initialValue > max) invalid('Numeric default must lie within the declared range.');
            numericOptions = `, min: ${literal(min)}, max: ${literal(max)}` + (step === undefined ? '' : `, step: ${literal(step as number)}`) + (slider === undefined ? '' : `, slide: ${literal(slider as boolean)}`);
        }
        if (type === 'enum') {
            if (!Array.isArray(row.entries) || row.entries.length < 1 || row.entries.length > 64) invalid('Enum requires 1..64 explicit entries.');
            const labels = new Set<string>(), values = new Set<number>(), entries: string[] = [];
            for (const entry of row.entries) {
                assertComponentScriptInput(entry, ['name', 'value']);
                if (!identifier(entry.name) || entry.name === '__enums__' || labels.has(entry.name) || typeof entry.value !== 'number' || !Number.isSafeInteger(entry.value) || entry.value < 0 || entry.value > 2147483647 || values.has(entry.value)) invalid('Enum labels and nonnegative int32 values must be safe and unique; automatic -1 values are not supported.');
                labels.add(entry.name); values.add(entry.value); entries.push(`${literal(entry.name)}: ${literal(entry.value)}`);
            }
            if (row.array === true) {
                const defaults = hasDefault ? row.default : [];
                if (!Array.isArray(defaults) || defaults.length > 256) invalid('Enum array defaults must contain at most 256 declared values.');
                for (let index = 0; index < defaults.length; index++) if (!Object.prototype.hasOwnProperty.call(defaults, index) || typeof defaults[index] !== 'number' || !values.has(defaults[index])) invalid('Enum array defaults must be dense and select declared values.');
                names.add(row.name); imports.add('Enum');
                fields.push(`    @property({ type: [Enum({ ${entries.join(', ')} })]${tooltip} })`, `    ${row.name}: number[] = [${defaults.map(value => literal(value)).join(', ')}];`, '');
                continue;
            }
            if (typeof row.default !== 'number' || !values.has(row.default)) invalid('Enum default must explicitly select one declared value.');
            names.add(row.name); imports.add('Enum');
            fields.push(`    @property({ type: Enum({ ${entries.join(', ')} })${tooltip} })`, `    ${row.name}: number = ${literal(row.default)};`, '');
            continue;
        }
        if (row.entries !== undefined) invalid('entries is supported only for enum fields.');
        if (row.array === true) {
            const values = hasDefault ? row.default : [];
            if (!Array.isArray(values) || values.length > 256) invalid('Array defaults must contain at most 256 entries.');
            const primitive = type === 'integer' || type === 'number' || type === 'string' || type === 'boolean';
            const vector = type === 'Size' || type === 'Rect' || type === 'Vec2' || type === 'Vec3' || type === 'Color' || (type === 'Quat' || type === 'Vec4');
            if (!primitive && !vector && values.length !== 0) invalid('Reference arrays must start empty; bind actual references separately in the Inspector.');
            const initializers: string[] = [];
            for (let index = 0; index < values.length; index++) {
                const value = values[index];
                if (!Object.prototype.hasOwnProperty.call(values, index)) invalid('Array defaults must be dense.');
                if (vector) {
                    const axes = type === 'Color' ? ['r', 'g', 'b', 'a'] : type === 'Size' ? ['width', 'height'] : type === 'Rect' ? ['x', 'y', 'width', 'height'] : (type === 'Quat' || type === 'Vec4') ? ['x', 'y', 'z', 'w'] : type === 'Vec2' ? ['x', 'y'] : ['x', 'y', 'z'];
                    assertComponentScriptInput(value, axes);
                    if (axes.some(axis => typeof value[axis] !== 'number' || !Number.isFinite(value[axis]))) invalid('Vector defaults require exactly the finite numeric coordinates of their declared type.');
                    if (type === 'Color' && axes.some(axis => !Number.isInteger(value[axis]) || (value[axis] as number) < 0 || (value[axis] as number) > 255)) invalid('Color defaults require exactly r/g/b/a integer bytes from 0 to 255.');
                    initializers.push(`new ${type}(${axes.map(axis => literal(value[axis] as number)).join(', ')})`);
                } else {
                    if (typeof value !== (type === 'integer' ? 'number' : type) || type === 'integer' && !Number.isSafeInteger(value) || type === 'number' && !Number.isFinite(value) || type === 'string' && value.length > 4096) invalid('Array defaults must be type-matched and bounded; numbers must be finite.');
                    initializers.push(literal(value));
                }
            }
            names.add(row.name);
            imports.add(PROPERTY_IMPORTS[type]);
            fields.push(tooltip ? `    @property({ type: [${PROPERTY_IMPORTS[type]}]${tooltip} })` : `    @property([${PROPERTY_IMPORTS[type]}])`, `    ${row.name}: ${type === 'integer' ? 'number' : type}[] = [${initializers.join(', ')}];`, '');
            continue;
        }
        let initial: string | number | boolean | null;
        if (type === 'Color') {
            const channels = ['r', 'g', 'b', 'a'];
            const value = hasDefault ? row.default : { r: 255, g: 255, b: 255, a: 255 };
            assertComponentScriptInput(value, channels);
            if (channels.some(channel => typeof value[channel] !== 'number' || !Number.isInteger(value[channel]) || (value[channel] as number) < 0 || (value[channel] as number) > 255)) invalid('Color defaults require exactly r/g/b/a integer bytes from 0 to 255.');
            names.add(row.name);
            imports.add(type);
            fields.push(tooltip ? `    @property({ type: Color${tooltip} })` : '    @property(Color)', `    ${row.name}: Color = new Color(${channels.map(channel => literal(value[channel] as number)).join(', ')});`, '');
            continue;
        }
        if (type === 'Size' || type === 'Rect' || type === 'Vec2' || type === 'Vec3' || (type === 'Quat' || type === 'Vec4')) {
            const axes = type === 'Size' ? ['width', 'height'] : type === 'Rect' ? ['x', 'y', 'width', 'height'] : (type === 'Quat' || type === 'Vec4') ? ['x', 'y', 'z', 'w'] : type === 'Vec2' ? ['x', 'y'] : ['x', 'y', 'z'];
            const value = hasDefault ? row.default : Object.fromEntries(axes.map(axis => [axis, type === 'Quat' && axis === 'w' ? 1 : 0]));
            assertComponentScriptInput(value, axes);
            if (axes.some(axis => typeof value[axis] !== 'number' || !Number.isFinite(value[axis]))) invalid('Vector defaults require exactly the finite numeric coordinates of their declared type.');
            names.add(row.name);
            imports.add(type);
            fields.push(tooltip ? `    @property({ type: ${type}${tooltip} })` : `    @property(${type})`, `    ${row.name}: ${type} = new ${type}(${axes.map(axis => literal(value[axis] as number)).join(', ')});`, '');
            continue;
        }
        if (type === 'number' || type === 'integer') {
            if (hasDefault && (typeof row.default !== 'number' || !Number.isFinite(row.default))) invalid('Number defaults must be finite numbers.');
            if (type === 'integer' && hasDefault && !Number.isSafeInteger(row.default)) invalid('Integer defaults must be safe integers.');
            initial = hasDefault ? row.default as number : 0;
        } else if (type === 'string') {
            if (hasDefault && (typeof row.default !== 'string' || row.default.length > 4096)) invalid('String defaults must be strings of at most 4096 characters.');
            initial = hasDefault ? row.default as string : '';
        } else if (type === 'boolean') {
            if (hasDefault && typeof row.default !== 'boolean') invalid('Boolean defaults must be booleans.');
            initial = hasDefault ? row.default as boolean : false;
        } else {
            if (hasDefault && row.default !== null) invalid('Reference defaults must be null; assign actual references separately in the Inspector.');
            initial = null;
        }
        names.add(row.name);
        imports.add(PROPERTY_IMPORTS[type]);
        fields.push(tooltip || numericOptions ? `    @property({ type: ${PROPERTY_IMPORTS[type]}${tooltip}${numericOptions} })` : `    @property(${PROPERTY_IMPORTS[type]})`, `    ${row.name}: ${initial === null ? `${type} | null` : type === 'integer' ? 'number' : type} = ${literal(initial)};`, '');
    }
    if (imports.has(input.className) || dependencies.size > 0 && input.className === 'requireComponent' || input.disallowMultiple !== undefined && input.className === 'disallowMultiple' || input.menu !== undefined && input.className === 'menu' || input.executionOrder !== undefined && input.className === 'executionOrder') invalid('className must not shadow a generated cc import or decorator.');
    const source = [
        '// Project-owned Creator 3.7 data component; typed data fields only, no gameplay or lifecycle behavior.',
        `import { ${[...imports].join(', ')} } from 'cc';`,
        `const { ccclass${fields.length ? ', property' : ''}${dependencies.size ? ', requireComponent' : ''}${input.disallowMultiple !== undefined ? ', disallowMultiple' : ''}${input.menu !== undefined ? ', menu' : ''}${input.executionOrder !== undefined ? ', executionOrder' : ''} } = _decorator;`,
        `@ccclass(${literal(input.className)})`,
        ...(dependencies.size ? [`@requireComponent([${[...dependencies].join(', ')}])`] : []),
        ...(input.disallowMultiple === undefined ? [] : [`@disallowMultiple(${literal(input.disallowMultiple as boolean)})`]),
        ...(input.menu === undefined ? [] : [`@menu(${literal(input.menu as string)})`]),
        ...(input.executionOrder === undefined ? [] : [`@executionOrder(${literal(input.executionOrder as number)})`]),
        `export class ${input.className} extends Component {`,
        ...fields,
        '}', '',
    ].join('\n');
    const bytes = Buffer.byteLength(source, 'utf8');
    if (bytes > MAX_SOURCE_BYTES) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Generated component source exceeds 64 KiB.' });
    return { source, sha256: componentScriptHash(source), bytes, className: input.className };
}

export function resolveComponentScriptPath(assetUrl: unknown): ComponentScriptPath {
    if (typeof assetUrl !== 'string' || assetUrl.length > 512 || !/^db:\/\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z][A-Za-z0-9_-]*\.ts$/.test(assetUrl)) invalid('assetUrl must be an exact db://assets/.../*.ts path with bounded safe path segments.');
    const project = typeof Editor.Project?.path === 'string' ? Editor.Project.path : '';
    if (!project) throw new ToolError({ code: 'PROJECT_UNAVAILABLE', status: 503, message: 'An open Creator project is required.' });
    try {
        const root = fs.realpathSync(project);
        const file = path.resolve(root, assetUrl.slice('db://'.length));
        const parent = fs.realpathSync(path.dirname(file));
        const relative = path.relative(root, parent);
        if ((relative !== 'assets' && !relative.startsWith(`assets${path.sep}`)) || path.resolve(parent, path.basename(file)) !== file) invalid('Component source parent must be project-owned assets, without symlink directory aliases.');
        if (!fs.statSync(parent).isDirectory()) throw new Error('Not a directory');
        return { assetUrl, file, parent, parentUrl: assetUrl.slice(0, assetUrl.lastIndexOf('/')) };
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Component source requires an existing accessible project assets parent directory.' });
    }
}
export async function queryComponentScriptAsset(url: string): Promise<ComponentScriptAsset | null> {
    let info: unknown;
    try { info = await Editor.Message.request('asset-db', 'query-asset-info', url); }
    catch { throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: 'Asset DB query failed; source ownership is unconfirmed.' }); }
    if (info === null) return null;
    if (!info || typeof info !== 'object') throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: 'Asset DB returned an invalid asset identity; absence is not confirmed.' });
    const row = info as Record<string, unknown>;
    if (typeof row.uuid !== 'string' || !row.uuid || typeof row.url !== 'string' || typeof row.file !== 'string') throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: 'Asset DB returned incomplete asset ownership information.' });
    return { uuid: row.uuid, url: row.url, file: row.file, isDirectory: row.isDirectory === true };
}
export async function preflightComponentScriptPath(assetUrl: string): Promise<ComponentScriptPath> {
    const source = resolveComponentScriptPath(assetUrl);
    const parent = await queryComponentScriptAsset(source.parentUrl);
    if (!parent || !parent.isDirectory || parent.url !== source.parentUrl || path.resolve(parent.file) !== source.parent) throw new ToolError({ code: 'SOURCE_PARENT_UNCONFIRMED', status: 409, message: 'Asset DB must confirm the exact existing project-owned parent directory.' });
    if (await queryComponentScriptAsset(assetUrl)) throw new ToolError({ code: 'SOURCE_CONFLICT', status: 409, message: 'Component source creation never overwrites or renames an existing Asset DB entry.' });
    for (const file of [source.file, `${source.file}.meta`]) {
        try { fs.lstatSync(file); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw new ToolError({ code: 'SOURCE_ACCESS_FAILED', status: 502, message: 'Cannot confirm absence of the requested source or metadata; no mutation was attempted.' });
        }
        throw new ToolError({ code: 'SOURCE_CONFLICT', status: 409, message: 'Component source creation refuses existing source or metadata entries, including dangling symlinks.' });
    }
    const current = resolveComponentScriptPath(assetUrl);
    if (current.file !== source.file || current.parent !== source.parent) throw new ToolError({ code: 'SOURCE_PARENT_CHANGED', status: 409, message: 'Source parent changed during preflight; no mutation was attempted.' });
    return source;
}
export async function readComponentScriptSource(source: ComponentScriptPath, uuid: string, expected: ComponentScriptSource): Promise<void> {
    let fd: number | undefined;
    try {
        const info = await queryComponentScriptAsset(source.assetUrl);
        const current = resolveComponentScriptPath(source.assetUrl);
        if (!info || info.uuid !== uuid || info.url !== source.assetUrl || path.resolve(info.file) !== source.file || current.file !== source.file || fs.lstatSync(source.file).isSymbolicLink() || fs.realpathSync(source.file) !== source.file) throw new Error('Source identity mismatch');
        fd = fs.openSync(source.file, 'r');
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size !== expected.bytes) throw new Error('Source size mismatch');
        const bytes = Buffer.alloc(expected.bytes + 1);
        let count = 0;
        while (count < bytes.length) {
            const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
            if (!read) break;
            count += read;
        }
        if (count !== expected.bytes || componentScriptHash(bytes.subarray(0, count)) !== expected.sha256) throw new Error('Source hash mismatch');
    } catch {
        throw new ToolError({ code: 'SOURCE_READBACK_UNCONFIRMED', status: 502, message: 'Created source identity/content could not be confirmed. Source may exist; no retry or deletion was attempted.', details: { assetUrl: source.assetUrl, expectedSha256: expected.sha256, sourceCreated: null, classRegistration: 'unknown', attached: false, runtimeVerified: false, sceneSaved: false } });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
