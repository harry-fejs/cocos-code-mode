'use strict';
const { SessionLifecycleHost } = require('./host');

/** Optional OMP adapter; CommonJS default interop needs no OMP package dependency. */
module.exports = function ccpSession(pi, { env = process.env, supervisorFactory } = {}) {
  let context;
  const display = status => {
    const text = `CCP ${status.state}: ${status.reason}`;
    try {
      if (context?.hasUI && typeof context.ui?.setStatus === 'function') {
        context.ui.setStatus('ccp-session', text);
      } else {
        pi.logger?.info(text);
      }
    } catch {}
  };
  const host = new SessionLifecycleHost({
    label: 'OMP',
    ...(env.CCP_SESSION_REGISTRY ? { registryPath: env.CCP_SESSION_REGISTRY } : {}),
    // Without a namespace the supervisor refuses multiple editors matching one project.
    ...(env.CCP_SESSION_NAMESPACE ? { namespace: env.CCP_SESSION_NAMESPACE } : {}),
    ...(supervisorFactory ? { supervisorFactory } : {}),
    emit: display,
  });
  const activate = async (_event, ctx) => {
    context = ctx;
    try {
      await host.switchSession({
        sessionId: ctx.sessionManager.getSessionId(),
        project: env.CCP_SESSION_PROJECT || ctx.cwd,
      });
    } catch (error) {
      // No endpoint/project/error text enters the UI or the model context.
      const reason = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'HOST_START_FAILED';
      display({ state: 'Error', reason });
    }
  };
  pi.on('session_start', activate);
  pi.on('session_switch', activate);
  pi.on('session_branch', activate);
  pi.on('session_shutdown', async (_event, ctx) => {
    context = ctx;
    try { await host.shutdown(); } catch { display({ state: 'Error', reason: 'HOST_SHUTDOWN_FAILED' }); }
  });
};
