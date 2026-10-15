import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { isMessageNotExposed } from '../utils/editor-message-error';
import * as fs from 'fs';
import * as path from 'path';

function profileRoot(): string {
  // Editor.Message.request('profile','query-config','project','general') also reads preview,
  // but 3.7 has no preview/set-config; filesystem is the only owner of general.start_scene.
  // We keep project/set-config as unsupported and handle preview profile separately.
  const project = (Editor as unknown as { Project?: { path?: string }, projectPath?: string }).Project?.path ?? (Editor as unknown as { projectPath?: string }).projectPath ?? '';
  if (project && typeof project === 'string') return path.join(project, 'profiles', 'v2', 'packages', 'preview.json');
  // fallback: guess from workspace (worktree -> .creator)
  return path.join(process.cwd(), 'profiles', 'v2', 'packages', 'preview.json');
}

async function readPreviewProfile(): Promise<{ data: Record<string, unknown>, file: string }> {
  // Prefer IPC when available (3.8+ may expose preview/query-config); fall back to filesystem.
  try {
    const fromIpc = await Editor.Message.request('preview', 'query-config', 'project', 'general') as Record<string, unknown> | null | undefined;
    if (fromIpc && typeof fromIpc === 'object' && typeof (fromIpc as Record<string, unknown>).start_scene === 'string') {
      return { data: fromIpc as Record<string, unknown>, file: 'preview:query-config' };
    }
  } catch (e) {
    if (!isMessageNotExposed(e, 'preview', 'query-config')) throw e;
  }
  const file = profileRoot();
  if (!fs.existsSync(file)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Preview profile not found', details: { file } });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  // schema: { __version__, general: { start_scene }, ... }
  const general = (raw as { general?: Record<string, unknown> }).general ?? raw;
  return { data: general as Record<string, unknown>, file };
}

async function writePreviewProfileStartScene(sceneUuid: string): Promise<Record<string, unknown>> {
  const file = profileRoot();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing: Record<string, unknown> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> : { __version__: '1.0.0' };
  const general = (existing.general ?? {}) as Record<string, unknown>;
  const nextGeneral = { ...general, start_scene: sceneUuid };
  const next: Record<string, unknown> = { ...existing, general: nextGeneral };
  const prevText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const nextText = JSON.stringify(next, null, 2);
  const tmp = `${file}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, nextText, 'utf8');
  fs.renameSync(tmp, file);
  // Refresh is advisory: file read-back below is the authoritative postcondition.
  try { await Editor.Message.request('asset-db', 'refresh'); } catch { /* Creator may not expose asset-db refresh. */ }
  // verify read-back
  const fresh = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const freshGeneral = (fresh.general ?? fresh) as Record<string, unknown>;
  if (String(freshGeneral.start_scene ?? fresh.start_scene) !== sceneUuid) {
    // rollback
    if (prevText !== null) { fs.writeFileSync(file, prevText, 'utf8'); }
    else { try { fs.unlinkSync(file); } catch { /* Nothing was created or it was already removed. */ } }
    throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: 'Preview start scene write did not survive read-back', details: { file, expected: sceneUuid } });
  }
  return freshGeneral as Record<string, unknown>;
}

export class PreviewStartSceneTools {
  @utcpTool(
    'previewStartSceneManage',
    'Preview start scene (editor profile profiles/v2/packages/preview.json general.start_scene). Get resolves db:// URL. Set is filesystem-backed (experimental) — validates scene asset exists, writes profile with snapshot/rollback and verifies read-back. Use for preview launch target.',
    {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['get', 'set'], description: 'get: read current preview start scene; set: overwrite profile start_scene' },
        sceneUuid: { type: 'string', description: 'Target scene UUID for set; must be a valid scene asset (validates via asset query)' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        sceneUuid: { type: 'string' },
        url: { type: 'string' },
        file: { type: 'string' },
        previous: { type: 'string' },
        _experimental: { type: 'string' },
      },
    } as never,
    'POST',
    ['preview', 'start scene', 'start_scene'],
  )
  async previewStartSceneManage(args: { operation: 'get' | 'set', sceneUuid?: string }): Promise<{ sceneUuid: string, url: string, file: string, previous?: string, _experimental?: string }> {
    if (args.operation === 'get') {
      const { data, file } = await readPreviewProfile();
      const uuid = String(data.start_scene ?? data.startScene ?? '');
      if (!uuid) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Preview start scene is not configured', details: { file } });
      let url = '';
      try { url = String((await Editor.Message.request('asset-db', 'query-url', uuid)) ?? ''); } catch { /* Query-path fallback below handles unavailable URL lookup. */ }
      if (!url) {
        // fallback resolve via library
        try { url = String((await Editor.Message.request('asset-db', 'query-path', uuid)) ?? ''); } catch { /* URL remains unavailable. */ }
      }
      return { sceneUuid: uuid, url, file };
    }
    if (args.operation === 'set') {
      const uuid = args.sceneUuid?.trim();
      if (!uuid) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'set requires sceneUuid (scene asset UUID)' });
      const info = await Editor.Message.request('asset-db', 'query-asset-info', uuid) as { uuid?: unknown, type?: unknown, url?: unknown } | null | undefined;
      if (!info) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Scene asset not found for uuid', details: { sceneUuid: uuid } });
      if (info.uuid !== uuid) throw new ToolError({ code: 'ASSET_IDENTITY_MISMATCH', status: 422, message: 'Asset DB returned a different scene identity.', details: { sceneUuid: uuid } });
      if (info.type !== 'cc.SceneAsset') throw new ToolError({ code: 'ASSET_TYPE_MISMATCH', status: 422, message: 'Target is not an authoritative scene asset.', details: { sceneUuid: uuid } });
      const assetUrl = info.url;
      if (typeof assetUrl !== 'string' || !assetUrl.startsWith('db://')) throw new ToolError({ code: 'ASSET_IDENTITY_MISMATCH', status: 422, message: 'Scene asset URL is unavailable.', details: { sceneUuid: uuid } });
      const before = await readPreviewProfile().then(r => String(r.data.start_scene ?? r.data.startScene ?? '')).catch(() => '');
      const _experimental = 'filesystem-backed: writes profiles/v2/packages/preview.json directly (3.7 preview/set-config IPC not exposed; guarded with snapshot/rollback and read-back)';
      const updated = await writePreviewProfileStartScene(uuid);
      const after = String((updated as Record<string, unknown>).start_scene ?? '');
      return { sceneUuid: after, url: assetUrl, file: profileRoot(), previous: before || undefined, _experimental };
    }
    throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Unknown operation '${String((args as { operation?: unknown }).operation)}'` });
  }
}
