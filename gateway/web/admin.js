"use strict";
const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
let csrf = "";
let view = "overview";
let offset = 0;
let generation = 0;
let sessionTimer;
const PAGE_SIZE = 100;
const titles = { overview: "Overview", usage: "Usage", requests: "Requests", errors: "Errors", latency: "Gateway phase latency (ms)", security: "Security events", devices: "Devices", grants: "Grants", versions: "Versions and compatibility" };
function message(text, error = false) { ui.message.textContent = text; ui.message.classList.toggle("error", error); }
function signOut() {
  csrf = ""; generation++; clearTimeout(sessionTimer);
  ui.workspace.hidden = true; ui["login-panel"].hidden = false; ui.logout.hidden = true; ui.identity.textContent = "Signed out";
  ui["table-body"].replaceChildren(); ui.summary.replaceChildren(); ui.portal.hidden = true;
}
async function request(path, options = {}) {
  const headers = { ...options.headers };
  if (options.method && options.method !== "GET") { headers["Content-Type"] = "application/json"; if (csrf) headers["x-ccp-csrf"] = csrf; }
  const response = await fetch(`/ccp/v1${path}`, { ...options, headers, credentials: "same-origin", cache: "no-store", redirect: "error" });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401) signOut();
    throw new Error(body?.error || `Request failed (${response.status})`);
  }
  return body;
}
function localDate(date) { return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
ui.filters.elements.from.value = localDate(new Date(Date.now() - 86_400_000));
ui.filters.elements.to.value = localDate(new Date(Date.now() + 30_000));
ui["create-grant"].elements.expiresAt.value = localDate(new Date(Date.now() + 86_400_000));
function query() {
  const values = new URLSearchParams();
  const inventory = view === "devices" || view === "grants";
  const allowed = inventory ? view === "devices" ? ["memberId", "deviceId", "status"] : ["memberId", "deviceId", "projectId", "toolId", "status"]
    : view === "versions" ? ["toolId"] : ["from", "to", "memberId", "deviceId", "projectId", "toolId", "relayBuild", "errorCode", "result", "groupBy"];
  for (const [key, value] of new FormData(ui.filters)) {
    if (!allowed.includes(key) || !value) continue;
    values.set(key, key === "from" || key === "to" ? String(new Date(value).getTime()) : value);
  }
  values.set("limit", PAGE_SIZE); values.set("offset", offset);
  return values;
}
function displayValue(key, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (key.endsWith("AtMs") || key === "timestampMs") return new Date(value).toLocaleString();
  if (typeof value === "number" && !Number.isInteger(value)) return value.toFixed(3);
  return String(value);
}
function renderRows(rows) {
  ui["table-head"].replaceChildren(); ui["table-body"].replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr"); const cell = document.createElement("td"); cell.textContent = "No matching records in this retained range."; row.append(cell); ui["table-body"].append(row); return;
  }
  const keys = Object.keys(rows[0]); const heading = document.createElement("tr");
  for (const key of [...keys, ...(["devices", "grants"].includes(view) ? ["Actions"] : [])]) {
    const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = key; heading.append(cell);
  }
  ui["table-head"].append(heading);
  for (const item of rows) {
    const row = document.createElement("tr");
    for (const key of keys) { const cell = document.createElement("td"); cell.textContent = displayValue(key, item[key]); row.append(cell); }
    if (view === "devices" || view === "grants") {
      const cell = document.createElement("td");
      const actions = view === "devices" && item.status === "pending" ? ["approve", "revoke"] : item.status !== "revoked" ? ["revoke"] : [];
      for (const action of actions) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = action; button.dataset.action = action;
        button.addEventListener("click", async () => {
          const scope = view === "devices" ? `device ${item.id}\nFingerprint: ${item.fingerprint}` : `grant ${item.id}`;
          if (!confirm(`${action.toUpperCase()} ${scope}?\nThis changes protected execution authority.`)) return;
          button.disabled = true;
          try { await request(`${view === "devices" ? "/devices" : "/admin/grants"}/${encodeURIComponent(item.id)}/${action}`, { method: "POST", body: "{}" }); await load(); message(`${action} completed.`); }
          catch (error) { message(error.message, true); button.disabled = false; }
        }); cell.append(button);
      }
      row.append(cell);
    }
    ui["table-body"].append(row);
  }
}
async function load() {
  const current = ++generation;
  ui["view-title"].textContent = titles[view]; ui["grant-panel"].hidden = view !== "grants";
  for (const button of ui.views.querySelectorAll("button")) {
    if (button.dataset.view === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
  ui.refresh.disabled = true; message("Loading…");
  try {
    const result = await request(`/admin/${view === "devices" || view === "grants" ? view : `analytics/${view}`}?${query()}`);
    if (current !== generation) return;
    ui.summary.replaceChildren();
    if (result.totals) {
      const labels = { requests: "Gateway requests", gatewaySigned: "Signed decisions (incl. retries)", gatewayDenied: "Gateway denials", gatewayErrors: "Gateway errors" };
      for (const [key, label] of Object.entries(labels)) {
        const card = document.createElement("div"); card.className = "card";
        const value = document.createElement("strong"); value.textContent = result.totals[key].toLocaleString();
        const text = document.createElement("span"); text.textContent = label; card.append(value, text); ui.summary.append(card);
      }
      const rate = document.createElement("p"); rate.textContent = `Gateway rejection rate: ${(result.totals.gatewayRejectionRate * 100).toFixed(2)}%`; ui.summary.append(rate);
    }
    for (const facet of result.facets || []) {
      const button = document.createElement("button"); button.textContent = `${facet.errorCode || "unknown"}: ${facet.requests}`;
      button.addEventListener("click", () => { ui.filters.elements.errorCode.value = facet.errorCode || ""; offset = 0; load(); });
      ui.summary.append(button);
    }
    renderRows(result.rows || result[view] || []);
    ui.coverage.textContent = result.measurement || result.coverage || (result.aggregateResolution ? `Usage totals use whole UTC hour buckets (${new Date(result.aggregateFrom).toLocaleString()} – ${new Date(result.aggregateTo).toLocaleString()}). Requests/latency use exact dates and 7-day detail retention.` : "Current inventory; date and request-outcome filters do not apply.");
    if (result.truncated) ui.coverage.textContent += " Results truncated to latest 10,000 matching requests; narrow dates for full coverage.";
    ui.previous.disabled = offset === 0 || view === "latency"; ui.next.disabled = !result.hasMore;
    ui.page.textContent = `Page ${offset / PAGE_SIZE + 1}`; message("");
  } catch (error) { if (current === generation) message(error.message, true); }
  finally { if (current === generation) ui.refresh.disabled = false; }
}
async function signedIn(session) {
  csrf = session.csrf; ui.identity.textContent = `${session.memberId} · expires ${new Date(session.expiresAtMs).toLocaleTimeString()}`;
  ui["login-panel"].hidden = true; ui.workspace.hidden = false; ui.logout.hidden = false;
  clearTimeout(sessionTimer); sessionTimer = setTimeout(() => { signOut(); message("Session expired. Sign in again."); }, Math.max(0, session.expiresAtMs - Date.now()));
  const nav = await request("/admin/navigation");
  if (nav.portalUrl) { ui.portal.href = nav.portalUrl; ui.portal.hidden = false; }
  await load();
}
ui.login.addEventListener("submit", async (event) => {
  event.preventDefault(); const credential = ui.credential.value; ui.credential.value = "";
  const button = ui.login.querySelector("button"); button.disabled = true;
  try { await signedIn(await request("/admin/session", { method: "POST", headers: { Authorization: `Bearer ${credential}` }, body: "{}" })); }
  catch (error) { message(error.message, true); } finally { button.disabled = false; }
});
ui.logout.addEventListener("click", async () => {
  try { await request("/admin/session", { method: "DELETE", body: "{}" }); signOut(); message("Signed out."); }
  catch (error) { message(error.message, true); }
});
ui.views.addEventListener("click", (event) => { const selected = event.target.closest("button[data-view]"); if (selected) { view = selected.dataset.view; offset = 0; load(); } });
ui.filters.addEventListener("submit", (event) => { event.preventDefault(); offset = 0; load(); });
ui.refresh.addEventListener("click", () => load());
ui.previous.addEventListener("click", () => { offset = Math.max(0, offset - PAGE_SIZE); load(); });
ui.next.addEventListener("click", () => { offset += PAGE_SIZE; load(); });
ui["create-grant"].addEventListener("submit", async (event) => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.target));
  if (!values.memberId && !values.deviceId) { message("A member or device is required.", true); return; }
  const body = { operationClass: values.operationClass, expiresAtMs: new Date(values.expiresAt).getTime() };
  for (const key of ["memberId", "deviceId", "projectId", "toolId"]) if (values[key]) body[key] = values[key];
  if (body.expiresAtMs <= Date.now()) { message("Grant expiry must be in the future.", true); return; }
  if (!confirm(`Grant ${body.operationClass} authority?\nMember: ${body.memberId || "any"}\nDevice: ${body.deviceId || "any"}\nProject: ${body.projectId || "any"}\nTool: ${body.toolId || "any"}`)) return;
  const button = event.target.querySelector("button"); button.disabled = true;
  try { await request("/admin/grants", { method: "POST", body: JSON.stringify(body) }); await load(); message("Scoped grant created."); }
  catch (error) { message(error.message, true); } finally { button.disabled = false; }
});
request("/admin/session").then(signedIn).catch(() => { signOut(); message("Sign in with a CCP administrator credential over HTTPS."); });
