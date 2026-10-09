import { join } from 'node:path';
import { writeJsonAtomic } from './storage.mjs';

export function recordVerifiedSession({ root = process.cwd(), project, bundle, sceneUuid, workingPath, task, verified }) {
  if (verified !== true) throw new Error('cocos-graph session-record requires verified=true after a live scene operation');
  if (!project || !bundle || !sceneUuid || !task) throw new Error('cocos-graph session-record requires project, bundle, sceneUuid, and task');
  const artifact = {
    project,
    bundle,
    sceneUuid,
    ...(workingPath ? { workingPath } : {}),
    task,
    updatedAt: new Date().toISOString(),
    age_ms: 0,
    verified: true,
  };
  writeJsonAtomic(join(root, '.claude', 'ccp-session.json'), artifact);
  return artifact;
}
