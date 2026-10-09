import packageJSON from '../../../package.json';
import { readFileSync } from 'fs-extra';
import { join } from 'path';
import { getConfigManager } from '../../utcp/config-manager';

module.exports = Editor.Panel.define({
    listeners: {
        show() { console.log('show'); },
        hide() { console.log('hide'); },
    },
    template: readFileSync(join(__dirname, '../../../static/template/configuration/index.html'), 'utf-8'),
    style: readFileSync(join(__dirname, '../../../static/style/configuration/index.css'), 'utf-8'),
    $: {
        app: '.panel',
        portInput: '#port-input',
        savePortBtn: '#save-port-btn',
        bootLogOutput: '#boot-log-output',
        copyBootLogBtn: '#copy-boot-log-btn',
        refreshBootLogBtn: '#refresh-boot-log-btn',
        // MCP Integration
        mcpConfigCode: '#mcp-config-code',
        
        // UTCP Config
        utcpConfigPathInput: '#utcp-config-path',
        utcpConfigPathSaveBtn: '#save-utcp-path-btn',
        bridgeList: '#bridge-container',
        addBridgeBtn: '#add-bridge-btn',
        newTemplateJson: '#new-template-json',
    },

    methods: {
        async loadSettings() {
            const configManager = getConfigManager();
            await configManager.initialize();

            // Update UI with config path
            if (this.$.utcpConfigPathInput) {
                (this.$.utcpConfigPathInput as any).value = configManager.getConfigPath();
            }

            // Load Port
            const port = await configManager.getCurrentPort();
            if (this.$.portInput) {
                (this.$.portInput as any).value = port || 0;
            }

            this.updateMcpCodeBlock();
            this.fetchBridgeList();
            this.refreshBootLog();
        },

        async refreshBootLog() {
            const output = this.$.bootLogOutput as HTMLTextAreaElement;
            if (!output) return;
            try {
                const result = await Editor.Message.request(packageJSON.name, 'get-boot-log', 200) as { path: string, lines: string[] };
                output.value = `${result.lines.join('\n')}\n\nLog file: ${result.path}`;
                output.scrollTop = output.scrollHeight;
            } catch (error) {
                output.value = `Unable to load boot log: ${error instanceof Error ? error.message : String(error)}`;
            }
        },

        async copyBootLog() {
            const output = this.$.bootLogOutput as HTMLTextAreaElement;
            if (!output) return;
            output.select();
            try {
                await navigator.clipboard.writeText(output.value);
            } catch {
                document.execCommand('copy');
            }
        },


        async saveSettings() {
            const newPath = (this.$.utcpConfigPathInput as any).value;
            if (newPath) {
                const configManager = getConfigManager();
                await configManager.setConfigPath(newPath);
                this.updateMcpCodeBlock();
                this.fetchBridgeList(); // Reload templates from new path
                console.log('Saved UTCP Config Path:', newPath);
            }
        },

        async updatePort() {
            const portVal = (this.$.portInput as any).value;
            const port = parseInt(portVal);
            console.log(`Updating port to: ${port}`);
            // Send message to main process to restart server
            Editor.Message.send(packageJSON.name, 'restart-server', port);
        },

        updateMcpCodeBlock() {
            const codeEl = this.$.mcpConfigCode as HTMLElement;
            if (!codeEl) return;

            const configManager = getConfigManager();
            const configPath = configManager.getConfigPath();

            const config = {
                "mcpServers": {
                    "ccp": {
                        "command": "npx",
                        "args": ["-y", "@utcp/code-mode-mcp"],
                        "env": {
                            "UTCP_CONFIG_FILE": configPath
                        }
                    }
                }
            };

            codeEl.textContent = JSON.stringify(config, null, 2);
        },

        fetchBridgeList() {
            const container = this.$.bridgeList as HTMLElement;
            if (!container) {
                console.warn('Bridge Config Container not found');
                return;
            }

            // Clear "Loading..." or previous content
            container.innerHTML = '';

            const configManager = getConfigManager();
            const config = configManager.readConfig();
            const templates = config.manual_call_templates || [];

            if (templates.length === 0) {
                container.innerHTML = '<div style="padding:10px; color: #888;">No templates found.</div>';
            } else {
                let html = '';
                templates.forEach((t: any) => {
                const isCocos = /^(ccp3x_\d+|ccp2x_\d+)$/.test(t.name);
                    const delBtn = isCocos
                        ? `` // No delete for Cocos
                        : `<ui-button slot="header" type="danger" class="remove-btn" tooltip="Remove Template">
                             <ui-icon value="del"></ui-icon>
                           </ui-button>`;

                    const headerText = `${t.name} (${t.call_template_type})`;

                    html += `
                    <ui-section class="bridge-item-section" data-name="${t.name}">
                        <div slot="header" style="display: flex; justify-content: space-between; align-items: center; width: 100%; padding-right: 10px;">
                            <ui-label>${headerText}</ui-label>
                            ${delBtn}
                        </div>
                        <div class="bridge-item-content">
                             <ui-code language="json" readonly id="code-${t.name}"></ui-code>
                        </div>
                    </ui-section>
                    `;
                });
                container.innerHTML = html;

                // Now populate the code values correctly
                templates.forEach((t: any) => {
                    const el = container.querySelector(`#code-${t.name}`) as any;
                    if (el) el.textContent = JSON.stringify(t, null, 2);
                });
            }
        },

        addBridgeTemplate() {
            const input = this.$.newTemplateJson as any;
            if (!input) return;
            const content = input.value.trim();
            if (!content) return;

            try {
                let newTpl = JSON.parse(content);
                // Validate with @utcp/sdk or simple schema
                if (!newTpl.name || !newTpl.call_template_type) {
                    alert('Invalid template. Must have name and call_template_type.');
                    return;
                }

                const configManager = getConfigManager();
                const config = configManager.readConfig();

                // Check duplicates
                if (config.manual_call_templates.find((t: any) => t.name === newTpl.name)) {
                    alert(`Template ${newTpl.name} already exists.`);
                    return;
                }

                config.manual_call_templates.push(newTpl);
                configManager.writeConfig(config);
                input.value = '';
                this.fetchBridgeList();

            } catch (e: any) {
                alert('Invalid JSON: ' + e.message);
            }
        },

        removeBridge(name: string) {
            if (/^(ccp3x_\d+|ccp2x_\d+)$/.test(name)) return;
            if (!confirm(`Remove template ${name}?`)) return;

            const configManager = getConfigManager();
            const config = configManager.readConfig();
            if (config.manual_call_templates) {
                config.manual_call_templates = config.manual_call_templates.filter((t: any) => t.name !== name);
                configManager.writeConfig(config);
                this.fetchBridgeList();
            }
        },
    },
    ready() {
        this.loadSettings();

        const savePort = this.$.savePortBtn as HTMLElement;
        if (savePort) savePort.addEventListener('click', () => this.updatePort());
        const copyBootLogBtn = this.$.copyBootLogBtn as HTMLElement;
        if (copyBootLogBtn) copyBootLogBtn.addEventListener('click', () => this.copyBootLog());
        const refreshBootLogBtn = this.$.refreshBootLogBtn as HTMLElement;
        if (refreshBootLogBtn) refreshBootLogBtn.addEventListener('click', () => this.refreshBootLog());
        const savePath = this.$.utcpConfigPathSaveBtn as HTMLElement;
        if (savePath) savePath.addEventListener('click', () => this.saveSettings());

        const addBtn = this.$.addBridgeBtn as HTMLElement;
        if (addBtn) addBtn.addEventListener('click', () => this.addBridgeTemplate());

        const list = this.$.bridgeList as HTMLElement;
        if (list) {
            list.addEventListener('click', (e: any) => {
                const btn = e.target.closest('.remove-btn');
                // Handle delete clicks
                if (btn) {
                    // In new structure, btn is inside .bridge-item-content inside ui-section
                    const section = btn.closest('.bridge-item-section');
                    if (section && section.dataset.name) {
                        this.removeBridge(section.dataset.name);
                    }
                }
            });
        }
    },
    beforeClose() { },
    close() { },
});